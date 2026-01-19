- [-] make it not ugly
- [ ] discover/recommended/explore/packs
  - [ ] mobile first; your subs on front page, fallback to
        discover/featured/recommended. search page init is discover page.
- [ ] launch
- [ ] ship bubbletea tui
- [ ] support for livestreaming / clubhouse
- [ ] copy keywords from episode description to channel table for search

<!--

TODO: to edit your subs/eps, just redirect to ?tag=mine

body.rows
  case episode of
    some ep ->
      div#player.rows
        ep.title
        video src=ep.src
  header.cols
    a href=telecast.company telecast.company
    case search of
      nothing ->
        a href=?q= search
      just _ ->
        a href=? x
  case search of
    nothing ->
      let channel = model.channel |> default my_feed
      div#channel.rows
        div
          h1 channel.name
          todo
        todo
    just search ->
      div#search.rows
        h1 search
        form.cols
          div.rows
            input#q
            div (availTags |> a href=&tag={tag.title} tag.title)
          button search
        div#results.autogrid
          list.map search.results
            div
              case member ch.id subs of
                true -> button x
                false -> button +
              ch.thumb
              ch.title
--->
