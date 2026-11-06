package main

import (
	"encoding/xml"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// run feeds msg to the model, then runs each returned command to completion and feeds its message back.
func run(t *testing.T, m tea.Model, msg tea.Msg) tea.Model {
	m, cmd := m.Update(msg)
	if cmd == nil {
		return m
	}
	out := cmd()
	if out == nil {
		return m
	}
	return run(t, m, out)
}

func key(s string) tea.KeyMsg {
	if s == "enter" {
		return tea.KeyMsg{Type: tea.KeyEnter}
	}
	return tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(s)}
}

func TestBrowseAndPlay(t *testing.T) {
	var feedPath string
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/search":
			if r.URL.Query().Get("q") != "tag:featured" {
				http.Error(w, "bad q", 400)
				return
			}
			w.Write([]byte(`[{"title":"One","rss":"https://one.test/a b.xml"},{"title":"Two","rss":"https://two.test/feed.xml"}]`))
		default:
			feedPath = r.URL.EscapedPath()
			w.Write([]byte(`<rss><channel><item><title>Ep1</title><enclosure url="https://cdn.test/ep1.mp3"/></item>
<item><title>Ep2</title><enclosure url="https://cdn.test/ep2.mp3"/></item></channel></rss>`))
		}
	}))
	defer site.Close()

	dir := t.TempDir()
	record := filepath.Join(dir, "args")
	script := "#!/bin/sh\necho \"$@\" > " + record + "\n"
	if err := os.WriteFile(filepath.Join(dir, "mpv"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))

	var m tea.Model = model{
		base: site.URL,
		exec: func(c *exec.Cmd, cb tea.ExecCallback) tea.Cmd {
			return func() tea.Msg { return cb(c.Run()) }
		},
	}
	m = run(t, m, m.Init()())
	m = run(t, m, key("j"))     // channel Two
	m = run(t, m, key("enter")) // open it
	m = run(t, m, key("j"))     // Ep2
	m = run(t, m, key("enter")) // play

	if got := m.(model).err; got != nil {
		t.Fatalf("expected no error, received %v", got)
	}
	if want := "/proxy/rss/https%3A%2F%2Ftwo.test%2Ffeed.xml"; feedPath != want {
		t.Fatalf("expected feed path %s, received %s", want, feedPath)
	}
	args, err := os.ReadFile(record)
	if err != nil {
		t.Fatalf("expected fake mpv to run, received %v", err)
	}
	if got := strings.TrimSpace(string(args)); got != "-- https://cdn.test/ep2.mp3" {
		t.Fatalf("expected mpv args -- https://cdn.test/ep2.mp3, received %q", got)
	}
}

func TestAtomLinkAndStaleFeed(t *testing.T) {
	m := model{base: "x"}
	var tm tea.Model = m
	tm, _ = tm.Update(channelsMsg{{Title: "A", RSS: "a"}, {Title: "B", RSS: "b"}})
	tm, _ = tm.Update(key("enter")) // open A
	tm, _ = tm.Update(key("esc"))
	tm, _ = tm.Update(key("j"))
	tm, _ = tm.Update(key("enter")) // open B
	// A's late answer must not replace B's list.
	tm, _ = tm.Update(episodesMsg{rss: "a", eps: []episode{{Title: "from A"}}})
	if got := len(tm.(model).episodes); got != 0 {
		t.Fatalf("expected no episodes from stale feed A while B loads, received %d", got)
	}

	var feed struct {
		Entries []episode `xml:"entry"`
	}
	atom := `<feed><entry><title>V</title><link rel="alternate" href="https://youtube.com/watch?v=1"/></entry></feed>`
	if err := xml.Unmarshal([]byte(atom), &feed); err != nil {
		t.Fatal(err)
	}
	if got := feed.Entries[0].src(); got != "https://youtube.com/watch?v=1" {
		t.Fatalf("expected Atom href as src, received %q", got)
	}
}

// A feed may carry src="--script=x"; mpv reads that as an option. playable rejects it, and "--" still precedes any src.
func TestHostileSrcIsNotAnOption(t *testing.T) {
	var got *exec.Cmd
	var tm tea.Model = model{base: "x", exec: func(c *exec.Cmd, cb tea.ExecCallback) tea.Cmd { got = c; return nil }}
	tm, _ = tm.Update(channelsMsg{{Title: "A", RSS: "a"}})
	tm, _ = tm.Update(key("enter"))
	e := episode{Title: "E"}
	e.Encl.URL = "--script=/tmp/x.lua"
	tm, _ = tm.Update(episodesMsg{rss: "a", eps: []episode{e}})
	tm.Update(key("enter"))
	if got != nil {
		t.Fatalf("expected no mpv for an option-like src, received %v", got.Args)
	}
}

// A failed fetch for a feed the user left must not show an error on the screen they are on.
func TestStaleFeedErrorDropped(t *testing.T) {
	var tm tea.Model = model{base: "x"}
	tm, _ = tm.Update(channelsMsg{{Title: "A", RSS: "a"}})
	tm, _ = tm.Update(key("enter"))
	tm, _ = tm.Update(key("esc"))
	tm, _ = tm.Update(episodesMsg{rss: "a", err: errors.New("boom")})
	if got := tm.(model).err; got != nil {
		t.Fatalf("expected no error after leaving feed A, received %v", got)
	}
}

func feedFrom(t *testing.T, body string) tea.Msg {
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(body)) }))
	t.Cleanup(site.Close)
	return model{base: site.URL}.fetchEpisodes(channel{RSS: "r"})()
}

// RSS feeds often declare ISO-8859-1; Go's decoder rejects that label unless given a CharsetReader.
func TestLatin1Feed(t *testing.T) {
	msg := feedFrom(t, "<?xml version=\"1.0\" encoding=\"ISO-8859-1\"?><rss><channel><item><title>Caf\xe9</title></item></channel></rss>").(episodesMsg)
	if msg.err != nil || len(msg.eps) != 1 || msg.eps[0].Title != "Café" {
		t.Fatalf("expected one episode titled Café, received %+v", msg)
	}
}

// A secondary <link> (Atom rel=replies, RSS atom:link) must not replace the page link.
func TestSrcIgnoresNonAlternateLinks(t *testing.T) {
	rss := feedFrom(t, `<rss xmlns:atom="http://www.w3.org/2005/Atom"><channel><item><title>x</title><link>https://a.test/ep</link><atom:link rel="replies" href="https://a.test/comments"/></item></channel></rss>`).(episodesMsg)
	atom := feedFrom(t, `<feed><entry><title>x</title><link rel="alternate" href="https://a.test/ep"/><link rel="replies" href="https://a.test/c"/></entry></feed>`).(episodesMsg)
	for _, msg := range []episodesMsg{rss, atom} {
		if got := msg.eps[0].src(); got != "https://a.test/ep" {
			t.Fatalf("expected https://a.test/ep, received %q", got)
		}
	}
}

// A feed src like file:///etc/passwd or a local path makes mpv open local files; only http(s) plays.
func TestNonHTTPSrcNotPlayed(t *testing.T) {
	for _, src := range []string{"file:///etc/passwd", "/etc/passwd", "ytdl://x", "  "} {
		ran := false
		var tm tea.Model = model{base: "x", exec: func(c *exec.Cmd, cb tea.ExecCallback) tea.Cmd { ran = true; return nil }}
		tm, _ = tm.Update(channelsMsg{{Title: "A", RSS: "a"}})
		tm, _ = tm.Update(key("enter"))
		e := episode{Title: "E"}
		e.Encl.URL = src
		tm, _ = tm.Update(episodesMsg{rss: "a", eps: []episode{e}})
		tm, _ = tm.Update(key("enter"))
		if ran || tm.(model).err == nil {
			t.Fatalf("expected an error and no mpv for src %q, received ran=%v err=%v", src, ran, tm.(model).err)
		}
	}
}

// Feed text is untrusted: an escape sequence in a title must not reach the terminal.
func TestViewStripsControlChars(t *testing.T) {
	m := model{channels: []channel{{Title: "a\x1b]0;pwned\x07b\nc"}}, err: errors.New("bad\x1b[2J")}
	if v := m.View(); strings.ContainsAny(v, "\x1b\x07") || strings.Count(v, "\n") != strings.Count(model{channels: []channel{{Title: "x"}}, err: errors.New("y")}.View(), "\n") {
		t.Fatalf("expected no control characters in View, received %q", v)
	}
}

// A list taller than the terminal must keep the cursor row on screen.
func TestViewScrollsToCursor(t *testing.T) {
	var cs []channel
	for i := 0; i < 50; i++ {
		cs = append(cs, channel{Title: fmt.Sprintf("ch%d", i)})
	}
	var tm tea.Model = model{channels: cs}
	tm, _ = tm.Update(tea.WindowSizeMsg{Width: 80, Height: 8})
	for i := 0; i < 30; i++ {
		tm, _ = tm.Update(key("j"))
	}
	v := tm.View()
	if n := strings.Count(v, "\n"); n > 8 || !strings.Contains(v, "> ch30\n") {
		t.Fatalf("expected at most 8 lines with cursor row ch30, received %d lines:\n%s", n, v)
	}
}

// mpv failing must say what was expected and what to do.
func TestPlayErrorHasContext(t *testing.T) {
	var tm tea.Model = model{base: "x", exec: func(c *exec.Cmd, cb tea.ExecCallback) tea.Cmd {
		return func() tea.Msg { return cb(errors.New("exit status 2")) }
	}}
	tm, _ = tm.Update(channelsMsg{{Title: "A", RSS: "a"}})
	tm, _ = tm.Update(key("enter"))
	e := episode{Title: "E"}
	e.Encl.URL = "https://x.test/a.mp3"
	tm, _ = tm.Update(episodesMsg{rss: "a", eps: []episode{e}})
	tm = run(t, tm, key("enter"))
	if got := tm.(model).err; got == nil || !strings.Contains(got.Error(), "https://x.test/a.mp3") {
		t.Fatalf("expected an error naming the src, received %v", got)
	}
}
