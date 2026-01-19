- [-] make it not ugly
- [ ] discover/recommended/explore/packs
  - [ ] mobile first; your subs on front page, fallback to
        discover/featured/recommended. search page init is discover page.
- [ ] launch
- [ ] ship bubbletea tui
- [ ] support for livestreaming / clubhouse
- [ ] copy keywords from episode description to channel table for search

<!--
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
        div.rows
          case is_my_feed of
            false ->
              div.cols
                img profileimg
                h1 username
                a href=/?tag=saved "my saved channels"
            true ->
              div.cols
                img channel.thumb
                h1 channel.name
                case todo of
                  _ -> button subscribe
                  _ -> button unsubscribe
          p description
        div.autogrid
          -- todo: filter out already watched episodes from feed?
          list.map channel.episodes
            div
              case member ep.id feed of
                true -> button x
                false -> button +
              ch.thumb
              ch.title
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
