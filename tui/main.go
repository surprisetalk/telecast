package main

import (
	"bytes"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"time"
	"unicode"

	tea "github.com/charmbracelet/bubbletea"
	"golang.org/x/text/encoding/charmap"
)

const baseURL = "https://telecast.company"

// channel and episode are checked records. Only decodeChannel and decodeEpisode build them.
type channel struct{ Title, RSS string }

type episode struct{ Title, Src string }

type rawChannel struct {
	Title string `json:"title"`
	RSS   string `json:"rss"`
}

type rawEpisode struct {
	Titles []struct {
		XMLName xml.Name
		Text    string `xml:",chardata"`
	} `xml:"title"`
	Links []struct {
		Rel  string `xml:"rel,attr"`
		Href string `xml:"href,attr"` // Atom (YouTube)
		Text string `xml:",chardata"` // RSS
	} `xml:"link"`
	Encl struct {
		URL string `xml:"url,attr"`
	} `xml:"enclosure"`
}

// Go matches "title" in any namespace, so <itunes:title> would overwrite <title>. Only RSS and Atom titles count.
func (e rawEpisode) title() string {
	for _, t := range e.Titles {
		if t.XMLName.Space == "" || t.XMLName.Space == "http://www.w3.org/2005/Atom" {
			return t.Text
		}
	}
	return ""
}

// REVIEW: Play the enclosure URL, else the page link (mpv hands YouTube links to yt-dlp). Alternative: skip episodes without an enclosure. It hides every YouTube channel.
func (e rawEpisode) src() string {
	if u := strings.TrimSpace(e.Encl.URL); u != "" {
		return u
	}
	// Atom entries and RSS items may carry several <link>s (rel=replies, rel=self). Only the page link plays.
	for _, l := range e.Links {
		if l.Rel != "" && l.Rel != "alternate" {
			continue
		}
		if u := strings.TrimSpace(l.Href); u != "" {
			return u
		}
		if u := strings.TrimSpace(l.Text); u != "" {
			return u
		}
	}
	return ""
}

// Feeds are untrusted. mpv opens local paths and exotic protocols, so only http(s) passes.
func isHTTP(s string) bool {
	u, err := url.Parse(s)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Hostname() != ""
}

// Escape sequences in feed text would run on the terminal, so a title with a control character fails.
func cleanTitle(s string) (string, bool) {
	s = strings.TrimSpace(s)
	return s, s != "" && strings.IndexFunc(s, unicode.IsControl) < 0
}

// REVIEW: An item that fails is dropped and counted under the list. Alternative: show it with the bad characters replaced. It hides which feeds are broken.
func decodeEpisode(r rawEpisode) (episode, bool) {
	t, ok := cleanTitle(r.title())
	src := r.src()
	return episode{t, src}, ok && isHTTP(src)
}

func decodeChannel(r rawChannel) (channel, bool) {
	t, ok := cleanTitle(r.Title)
	return channel{t, r.RSS}, ok && isHTTP(r.RSS)
}

// Replace every control character. Errors may quote feed or server text.
func clean(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, s)
}

// Go's XML decoder knows only UTF-8. Many RSS feeds declare ISO-8859-1; browsers read that label as windows-1252.
func charsetReader(label string, in io.Reader) (io.Reader, error) {
	switch strings.ToLower(label) {
	case "iso-8859-1", "latin1", "windows-1252":
		return charmap.Windows1252.NewDecoder().Reader(in), nil
	}
	return nil, fmt.Errorf("expected feed charset utf-8, iso-8859-1 or windows-1252, received %q", label)
}

type model struct {
	base     string
	exec     func(*exec.Cmd, tea.ExecCallback) tea.Cmd
	channels []channel
	episodes []episode
	badChs   int      // channels that failed to decode
	badEps   int      // episodes of the picked channel that failed to decode
	picked   *channel // nil while the channel list shows
	cursor   int
	err      error
	height   int // 0 until the terminal reports its size
}

type channelsMsg struct {
	channels []channel
	bad      int
}

// rss names the feed asked for, so a late answer or error for a channel the user left is dropped.
type episodesMsg struct {
	rss string
	eps []episode
	bad int
	err error
}
type errMsg struct{ error }
type playedMsg struct{ err error }

var client = &http.Client{Timeout: 15 * time.Second}

func get(u string) ([]byte, error) {
	res, err := client.Get(u)
	if err != nil {
		return nil, fmt.Errorf("expected GET %s to answer, received %w. Check the network.", u, err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 50<<20))
	if err != nil {
		return nil, fmt.Errorf("expected the body of %s, received %w", u, err)
	}
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("expected status 200 from %s, received %d: %.200s", u, res.StatusCode, body)
	}
	return body, nil
}

func (m model) fetchChannels() tea.Msg {
	body, err := get(m.base + "/search?q=" + url.QueryEscape("tag:featured"))
	if err != nil {
		return errMsg{err}
	}
	var raw []rawChannel
	if err := json.Unmarshal(body, &raw); err != nil {
		return errMsg{fmt.Errorf("expected a JSON array of channels from /search, received %w", err)}
	}
	var msg channelsMsg
	for _, r := range raw {
		if c, ok := decodeChannel(r); ok {
			msg.channels = append(msg.channels, c)
		} else {
			msg.bad++
		}
	}
	return msg
}

func (m model) fetchEpisodes(c channel) tea.Cmd {
	return func() tea.Msg {
		// Same encoding as Elm Url.percentEncode: ":" and "/" escaped, space as %20.
		body, err := get(m.base + "/proxy/rss/" + strings.ReplaceAll(url.QueryEscape(c.RSS), "+", "%20"))
		if err != nil {
			return episodesMsg{rss: c.RSS, err: err}
		}
		// Atom (YouTube) wraps items in <entry>, RSS in <item>. Decode both.
		var feed struct {
			Items   []rawEpisode `xml:"channel>item"`
			Entries []rawEpisode `xml:"entry"`
		}
		dec := xml.NewDecoder(bytes.NewReader(body))
		dec.CharsetReader = charsetReader
		if err := dec.Decode(&feed); err != nil {
			return episodesMsg{rss: c.RSS, err: fmt.Errorf("expected feed XML for %s, received %w", c.RSS, err)}
		}
		msg := episodesMsg{rss: c.RSS}
		for _, r := range append(feed.Items, feed.Entries...) {
			if e, ok := decodeEpisode(r); ok {
				msg.eps = append(msg.eps, e)
			} else {
				msg.bad++
			}
		}
		return msg
	}
}

func (m model) Init() tea.Cmd { return m.fetchChannels }

func (m model) bad() int {
	if m.picked == nil {
		return m.badChs
	}
	return m.badEps
}

func (m model) rows() int {
	if m.picked == nil {
		return len(m.channels)
	}
	return len(m.episodes)
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.height = msg.Height
	case channelsMsg:
		m.channels, m.badChs = msg.channels, msg.bad
	case episodesMsg:
		if m.picked != nil && m.picked.RSS == msg.rss {
			m.episodes, m.badEps, m.err = msg.eps, msg.bad, msg.err
		}
	case errMsg:
		m.err = msg
	case playedMsg:
		if msg.err != nil {
			m.err = fmt.Errorf("expected mpv to play the episode, received %w. Check that mpv is installed and the URL works", msg.err)
		}
	case tea.KeyMsg:
		switch msg.String() {
		case "q", "ctrl+c":
			return m, tea.Quit
		case "up", "k":
			if m.cursor > 0 {
				m.cursor--
			}
		case "down", "j":
			if m.cursor < m.rows()-1 {
				m.cursor++
			}
		case "esc", "left", "h":
			m.picked, m.episodes, m.badEps, m.cursor, m.err = nil, nil, 0, 0, nil
		case "enter", "right", "l":
			if m.rows() == 0 {
				return m, nil
			}
			if m.picked == nil {
				c := m.channels[m.cursor]
				m.picked, m.cursor = &c, 0
				return m, m.fetchEpisodes(c)
			}
			src := m.episodes[m.cursor].Src
			return m, m.exec(exec.Command("mpv", "--", src), func(err error) tea.Msg {
				if err != nil {
					err = fmt.Errorf("%s: %w", src, err)
				}
				return playedMsg{err}
			})
		}
	}
	return m, nil
}

func (m model) View() string {
	var b strings.Builder
	var titles []string
	if m.picked == nil {
		b.WriteString("telecast: featured\n\n")
		for _, c := range m.channels {
			titles = append(titles, c.Title)
		}
	} else {
		b.WriteString(m.picked.Title + "\n\n")
		for _, e := range m.episodes {
			titles = append(titles, e.Title)
		}
	}
	// 6 lines of header, error and footer stay, plus 2 for the failure count; the rest scrolls with the cursor.
	reserved := 6
	if m.bad() > 0 {
		reserved += 2
	}
	lo, hi := 0, len(titles)
	if h := m.height - reserved; m.height > 0 && h < hi && hi > 0 {
		h = max(h, 1)
		lo = min(max(m.cursor-h/2, 0), len(titles)-h)
		hi = lo + h
	}
	for i := lo; i < hi; i++ {
		cur := "  "
		if i == m.cursor {
			cur = "> "
		}
		b.WriteString(cur + titles[i] + "\n")
	}
	if bad := m.bad(); bad > 0 {
		fmt.Fprintf(&b, "\n%d items failed to decode (bad title or non-http(s) URL)\n", bad)
	}
	if m.err != nil {
		b.WriteString("\nerror: " + clean(m.err.Error()) + "\n")
	}
	b.WriteString("\nenter play/open, esc back, q quit\n")
	return b.String()
}

func main() {
	m := model{base: baseURL, exec: tea.ExecProcess}
	if _, err := tea.NewProgram(m).Run(); err != nil {
		fmt.Fprintln(os.Stderr, "tui:", err)
		os.Exit(1)
	}
}
