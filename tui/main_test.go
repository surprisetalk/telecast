package main

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
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
			w.Write([]byte(`[{"title":"Ep1","src":"https://cdn.test/ep1.mp3","link":null},{"title":"Ep2","src":"https://cdn.test/ep2.mp3","link":null}]`))
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
	if want := "/episodes/https%3A%2F%2Ftwo.test%2Ffeed.xml"; feedPath != want {
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

func chs(titles ...string) channelsMsg {
	var m channelsMsg
	for _, t := range titles {
		m.channels = append(m.channels, channel{t, t})
	}
	return m
}

func TestStaleFeed(t *testing.T) {
	var tm tea.Model = model{base: "x"}
	tm, _ = tm.Update(chs("a", "b"))
	tm, _ = tm.Update(key("enter")) // open a
	tm, _ = tm.Update(key("esc"))
	tm, _ = tm.Update(key("j"))
	tm, _ = tm.Update(key("enter")) // open b
	// a's late answer must not replace b's list.
	tm, _ = tm.Update(episodesMsg{rss: "a", eps: []episode{{"from a", "https://a.test/x"}}})
	if got := len(tm.(model).episodes); got != 0 {
		t.Fatalf("expected no episodes from stale feed a while b loads, received %d", got)
	}
}

// Raw feed data reaches the model only through the decoder. A bad title or src is counted, never shown or played.
func TestDecodeEpisodes(t *testing.T) {
	msg := feedFrom(t, `[
{"title":"Café","src":"https://cdn.test/a.mp3","link":"https://a.test/a"},
{"title":"page link","src":null,"link":"https://a.test/ep"},
{"title":"option","src":"--script=/tmp/x.lua","link":null},
{"title":"file","src":"file:///etc/passwd","link":null},
{"title":"nohost","src":"http://:80/x","link":null},
{"title":"none","src":null,"link":null},
{"title":"C1\u0085CSI","src":"https://cdn.test/b.mp3","link":null}
]`).(episodesMsg)
	want := []episode{{"Café", "https://cdn.test/a.mp3"}, {"page link", "https://a.test/ep"}}
	if msg.err != nil || !reflect.DeepEqual(msg.eps, want) || msg.bad != 5 {
		t.Fatalf("expected episodes %v and 5 failures, received %+v", want, msg)
	}
	if bad := feedFrom(t, `{"error":"x"}`).(episodesMsg); bad.err == nil || !strings.Contains(bad.err.Error(), "JSON array of episodes") {
		t.Fatalf("expected a JSON array error, received %+v", bad)
	}
}

// Channels from /search get the same check, and the count shows under the list.
func TestDecodeChannels(t *testing.T) {
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`[{"title":"ok","rss":"https://a.test/f"},{"title":"a\u001b[2Jb","rss":"https://a.test/g"},{"title":"file","rss":"file:///x"},{"title":"","rss":"https://a.test/h"}]`))
	}))
	defer site.Close()
	m := model{base: site.URL}
	tm := run(t, m, m.Init()())
	v := tm.View()
	if got := tm.(model).channels; !reflect.DeepEqual(got, []channel{{"ok", "https://a.test/f"}}) || !strings.Contains(v, "3 items failed to decode") || strings.Contains(v, "\x1b") {
		t.Fatalf("expected one channel and a 3-failure line, received %+v\n%q", got, v)
	}
}

// A failed fetch for a feed the user left must not show an error on the screen they are on.
func TestStaleFeedErrorDropped(t *testing.T) {
	var tm tea.Model = model{base: "x"}
	tm, _ = tm.Update(chs("a"))
	tm, _ = tm.Update(key("enter"))
	tm, _ = tm.Update(key("esc"))
	tm, _ = tm.Update(episodesMsg{rss: "a", err: errors.New("boom")})
	if got := tm.(model).err; got != nil {
		t.Fatalf("expected no error after leaving feed a, received %v", got)
	}
}

func feedFrom(t *testing.T, body string) tea.Msg {
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(body)) }))
	t.Cleanup(site.Close)
	return model{base: site.URL}.fetchEpisodes(channel{RSS: "r"})()
}

// Errors may quote server text: an escape sequence in one must not reach the terminal.
func TestViewStripsControlCharsInErrors(t *testing.T) {
	v := model{channels: []channel{{"x", "https://x.test"}}, err: errors.New("bad\x1b[2J")}.View()
	if strings.ContainsAny(v, "\x1b\x07") {
		t.Fatalf("expected no control characters in View, received %q", v)
	}
}

// A list taller than the terminal must keep the cursor row on screen.
func TestViewScrollsToCursor(t *testing.T) {
	var titles []string
	for i := 0; i < 50; i++ {
		titles = append(titles, fmt.Sprintf("ch%d", i))
	}
	var tm tea.Model = model{channels: chs(titles...).channels}
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
	tm, _ = tm.Update(chs("a"))
	tm, _ = tm.Update(key("enter"))
	tm, _ = tm.Update(episodesMsg{rss: "a", eps: []episode{{"E", "https://x.test/a.mp3"}}})
	tm = run(t, tm, key("enter"))
	if got := tm.(model).err; got == nil || !strings.Contains(got.Error(), "https://x.test/a.mp3") {
		t.Fatalf("expected an error naming the src, received %v", got)
	}
}

// The failure count takes two lines. With it and an error showing, the list must still fit the terminal.
func TestViewFitsWithFailureCountAndError(t *testing.T) {
	var titles []string
	for i := 0; i < 50; i++ {
		titles = append(titles, fmt.Sprintf("ch%d", i))
	}
	var tm tea.Model = model{channels: chs(titles...).channels, badChs: 3, err: errors.New("boom")}
	tm, _ = tm.Update(tea.WindowSizeMsg{Width: 80, Height: 12})
	for i := 0; i < 30; i++ {
		tm, _ = tm.Update(key("j"))
	}
	v := tm.View()
	if n := strings.Count(v, "\n"); n > 12 || !strings.Contains(v, "> ch30\n") {
		t.Fatalf("expected at most 12 lines with cursor row ch30, received %d lines:\n%s", n, v)
	}
}

func TestViewEmptyListSmallTerminal(t *testing.T) {
	var tm tea.Model = model{}
	tm, _ = tm.Update(tea.WindowSizeMsg{Width: 80, Height: 5})
	tm.View()
}
