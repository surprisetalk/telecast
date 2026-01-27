port module Main exposing (main)

import Browser
import Browser.Navigation as Nav
import Char
import Dict exposing (Dict)
import Html exposing (..)
import Html.Attributes as A exposing (class, href, id, src, value)
import Html.Events exposing (onClick, onInput, onSubmit)
import Http
import Json.Decode as D
import Json.Decode.Pipeline as D
import Json.Encode as E
import Set exposing (Set)
import Task
import Time
import Url exposing (Url)
import Url.Parser as P exposing ((</>), Parser)
import Xml.Decode as X



-- PORTS


port libraryLoaded : (D.Value -> msg) -> Sub msg


port librarySaving : E.Value -> Cmd msg



-- TYPES


type alias Id =
    String


type
    Loadable a
    -- Nothing                 -- inert
    -- Just (Err "Loading...") -- loading
    -- Just (Err err)          -- err
    -- Just (Ok a)             -- a
    = Loadable (Maybe (Result String a))


{-| Extract the loaded value if present and successful.
-}
isLoaded : Loadable a -> Maybe a
isLoaded (Loadable m) =
    case m of
        Just (Ok a) ->
            Just a

        _ ->
            Nothing


type alias Model =
    { library : Loadable Library
    , key : Nav.Key
    , channel : Maybe ( Url, Loadable Feed )
    , search : Maybe SearchState
    , episode : Maybe Id -- episode ID
    , refreshing : Maybe (Set String) -- Nothing = idle, Just pending = refreshing RSS URLs
    }


type alias SearchState =
    { query : String
    , results : Loadable (List Channel)
    }


type alias Feed =
    { channel : Channel
    , episodes : Dict String Episode -- keyed by episode src URL
    }


type alias Library =
    { channels : Dict String Channel -- subscribed channels by RSS URL
    , episodes : Dict String (Dict String Episode) -- channel RSS -> episode ID -> Episode
    , queue : Dict String Episode -- "watch later" queue: episode ID -> Episode
    , watched : Set String -- watched episode IDs
    , history : Dict String (Dict String (List Playback)) -- playback progress
    , settings : {}
    }


type alias Playback =
    { t : Time.Posix
    , s : ( Int, Int )
    }


type alias Channel =
    { title : String
    , description : String
    , thumb : Maybe Url
    , rss : Url
    , updatedAt : String
    , author : Maybe String
    , episodeCount : Maybe Int
    , categories : Maybe (List String)
    }


type alias Episode =
    { id : Id
    , title : String
    , thumb : Maybe Url -- 16:9 video thumbnail (media:thumbnail)
    , coverArt : Maybe Url -- Square album art (itunes:image)
    , src : Url
    , description : String
    , index : Int
    , durationSeconds : Maybe Int
    , publishedAt : Maybe String
    , season : Maybe Int
    , episodeNum : Maybe Int
    , channelTitle : Maybe String
    , channelThumb : Maybe Url
    , isShort : Bool
    , viewCount : Maybe Int
    , fileSizeBytes : Maybe Int
    , isExplicit : Bool
    }



-- MAIN


main : Program D.Value Model Msg
main =
    Browser.application
        { init = init
        , view = view
        , update = update
        , subscriptions = subscriptions
        , onUrlRequest = LinkClicked
        , onUrlChange = UrlChanged
        }



-- INIT


init : D.Value -> Url -> Nav.Key -> ( Model, Cmd Msg )
init flags url key =
    route url
        { library =
            flags
                |> D.decodeValue libraryDecoder
                |> Result.mapError (always "Could not parse library.")
                |> Just
                |> Loadable
        , key = key
        , channel = Nothing
        , search = Nothing
        , episode = Nothing
        , refreshing = Nothing
        }



-- SUBSCRIPTIONS


subscriptions : Model -> Sub Msg
subscriptions _ =
    Sub.batch
        [ libraryLoaded (D.decodeValue libraryDecoder >> LibraryLoaded)
        ]



-- MSG


type Msg
    = LibraryLoaded (Result D.Error Library)
    | FeedFetched String (Maybe Id) (Result String Feed)
    | ChannelsFetched (Result Http.Error (List Channel))
    | SearchEditing String
    | SearchSubmitting
    | ChannelSubscribing String Channel
    | ChannelUnsubscribing String
    | EpisodeQueued Episode
    | EpisodeWatched Id
    | GoBack
    | LinkClicked Browser.UrlRequest
    | UrlChanged Url
    | RefreshFeeds
    | RefreshFeedFetched String (Result String Feed)



-- UPDATE


update : Msg -> Model -> ( Model, Cmd Msg )
update msg model =
    case msg of
        LibraryLoaded (Ok lib) ->
            ( { model | library = Loadable (Just (Ok lib)) }
            , Task.perform (always RefreshFeeds) (Task.succeed ())
            )

        LibraryLoaded (Err _) ->
            ( { model | library = Loadable (Just (Err "Could not load library.")) }
            , Cmd.none
            )

        FeedFetched originalRss maybeEpisodeId (Ok feed) ->
            let
                rssUrl =
                    Url.fromString originalRss |> Maybe.withDefault feed.channel.rss

                setChannelRss : Url -> Channel -> Channel
                setChannelRss url channel =
                    { channel | rss = url }

                correctedFeed =
                    { feed | channel = setChannelRss rssUrl feed.channel }
            in
            ( { model | channel = Just ( rssUrl, Loadable (Just (Ok correctedFeed)) ), search = Nothing, episode = maybeEpisodeId }
            , Cmd.none
            )

        FeedFetched originalRss maybeEpisodeId (Err err) ->
            case model.channel of
                Just ( rssUrl, _ ) ->
                    ( { model | channel = Just ( rssUrl, Loadable (Just (Err err)) ) }
                    , Cmd.none
                    )

                Nothing ->
                    ( model, Cmd.none )

        ChannelsFetched result ->
            case model.search of
                Just searchState ->
                    case result of
                        Ok channels ->
                            let
                                localMatches =
                                    getLibrary model
                                        |> Maybe.map (.channels >> Dict.values >> List.filter (\c -> String.contains (String.toLower searchState.query) (String.toLower c.title)))
                                        |> Maybe.withDefault []
                            in
                            ( { model | search = Just { searchState | results = Loadable (Just (Ok (localMatches ++ channels))) } }
                            , Cmd.none
                            )

                        Err err ->
                            ( { model | search = Just { searchState | results = Loadable (Just (Err (httpErrorToString err))) } }
                            , Cmd.none
                            )

                Nothing ->
                    ( model, Cmd.none )

        SearchEditing query ->
            case model.search of
                Just searchState ->
                    ( { model | search = Just { searchState | query = query } }
                    , Nav.replaceUrl model.key ("/?q=" ++ Url.percentEncode query)
                    )

                Nothing ->
                    ( model, Cmd.none )

        SearchSubmitting ->
            case model.search of
                Just searchState ->
                    ( { model | search = Just { searchState | results = Loadable Nothing } }
                    , Cmd.batch
                        [ Nav.pushUrl model.key ("/?q=" ++ Url.percentEncode searchState.query)
                        , Http.get
                            { url = "/search?q=" ++ Url.percentEncode searchState.query
                            , expect = Http.expectJson ChannelsFetched (D.list channelDecoder)
                            }
                        ]
                    )

                Nothing ->
                    ( model, Cmd.none )

        ChannelSubscribing channelId channel ->
            case model.channel of
                Just ( _, Loadable (Just (Ok feed)) ) ->
                    let
                        enrichedEpisodes =
                            Dict.map (\_ ep -> enrichEpisodeWith channel ep) feed.episodes

                        -- Add most recent 3 episodes to queue (enriched)
                        recentEpisodes =
                            enrichedEpisodes
                                |> Dict.values
                                |> List.take 3
                                |> List.map (\ep -> ( ep.id, ep ))
                                |> Dict.fromList
                    in
                    withLibrary
                        (\lib ->
                            { lib
                                | channels = Dict.insert channelId channel lib.channels
                                , episodes = Dict.insert channelId enrichedEpisodes lib.episodes
                                , queue = Dict.union recentEpisodes lib.queue
                            }
                        )
                        model

                _ ->
                    -- No feed loaded: subscribe with channel only (from search results)
                    withLibrary
                        (\lib ->
                            { lib
                                | channels = Dict.insert channelId channel lib.channels
                                , episodes =
                                    if Dict.member channelId lib.episodes then
                                        lib.episodes

                                    else
                                        Dict.insert channelId Dict.empty lib.episodes
                            }
                        )
                        model

        ChannelUnsubscribing channelId ->
            withLibrary
                (\lib ->
                    { lib
                        | channels = Dict.remove channelId lib.channels
                        , episodes = Dict.remove channelId lib.episodes
                    }
                )
                model

        EpisodeQueued episode ->
            withLibrary
                (\lib -> { lib | queue = Dict.insert episode.id episode lib.queue })
                model

        EpisodeWatched episodeId ->
            withLibrary
                (\lib -> { lib | watched = Set.insert episodeId lib.watched })
                model

        GoBack ->
            ( model, Nav.back model.key 1 )

        LinkClicked (Browser.Internal url) ->
            ( model
            , Nav.pushUrl model.key (Url.toString url)
            )

        LinkClicked (Browser.External url) ->
            ( model
            , Nav.load url
            )

        UrlChanged url ->
            route url model

        RefreshFeeds ->
            case model.library of
                Loadable (Just (Ok lib)) ->
                    let
                        rssUrls =
                            Dict.keys lib.channels

                        cmds =
                            rssUrls
                                |> List.map
                                    (\rss ->
                                        Http.get
                                            { url = "/proxy/rss/" ++ Url.percentEncode rss
                                            , expect = Http.expectString (Result.mapError httpErrorToString >> Result.andThen (X.run feedDecoder) >> RefreshFeedFetched rss)
                                            }
                                    )
                    in
                    if List.isEmpty rssUrls then
                        ( model, Cmd.none )

                    else
                        ( { model | refreshing = Just (Set.fromList rssUrls) }
                        , Cmd.batch cmds
                        )

                _ ->
                    ( model, Cmd.none )

        RefreshFeedFetched rss result ->
            case ( model.library, model.refreshing ) of
                ( Loadable (Just (Ok lib)), Just pending ) ->
                    let
                        newPending =
                            Set.remove rss pending

                        refreshDone =
                            Set.isEmpty newPending
                    in
                    case result of
                        Ok feed ->
                            let
                                enrichedFeedEpisodes =
                                    Dict.map (\_ ep -> enrichEpisodeWith feed.channel ep) feed.episodes

                                -- Get existing stored episodes for this channel
                                existingEpisodes =
                                    Dict.get rss lib.episodes
                                        |> Maybe.withDefault Dict.empty

                                -- Find new episodes: in feed but not in stored episodes and not watched
                                newEpisodes =
                                    enrichedFeedEpisodes
                                        |> Dict.filter
                                            (\epId _ ->
                                                not (Dict.member epId existingEpisodes)
                                                    && not (Set.member epId lib.watched)
                                            )

                                -- Update library
                                updatedLib =
                                    { lib
                                        | episodes = Dict.insert rss enrichedFeedEpisodes lib.episodes
                                        , queue = Dict.union newEpisodes lib.queue
                                    }
                            in
                            ( { model
                                | library = Loadable (Just (Ok updatedLib))
                                , refreshing =
                                    if refreshDone then
                                        Nothing

                                    else
                                        Just newPending
                              }
                            , librarySaving (libraryEncoder updatedLib)
                            )

                        Err _ ->
                            -- On error, just remove from pending and continue
                            ( { model
                                | refreshing =
                                    if refreshDone then
                                        Nothing

                                    else
                                        Just newPending
                              }
                            , Cmd.none
                            )

                _ ->
                    ( model, Cmd.none )



-- ROUTING


route : Url -> Model -> ( Model, Cmd Msg )
route url model =
    let
        -- TODO: Use Url.Parser
        parseQueryParams : String -> Dict String String
        parseQueryParams query =
            query
                |> String.split "&"
                |> List.filterMap
                    (\pair ->
                        case String.split "=" pair of
                            [ key, value ] ->
                                Just ( key, Url.percentDecode value |> Maybe.withDefault value )

                            [ key ] ->
                                Just ( key, "" )

                            _ ->
                                Nothing
                    )
                |> Dict.fromList

        -- Parse query params
        queryParams =
            url.query
                |> Maybe.map parseQueryParams
                |> Maybe.withDefault Dict.empty

        searchQuery =
            Dict.get "q" queryParams

        tagFilter =
            Dict.get "tag" queryParams

        episodeId =
            Dict.get "e" queryParams
                |> Maybe.andThen Url.percentDecode
    in
    case ( url.path, searchQuery, tagFilter ) of
        -- Saved channels: /?tag=saved
        ( "/", Nothing, Just "saved" ) ->
            ( { model
                | search = Just { query = "", results = Loadable (Just (Ok (getLibrary model |> Maybe.map (.channels >> Dict.values) |> Maybe.withDefault []))) }
                , channel = Nothing
                , episode = episodeId
              }
            , Cmd.none
            )

        -- Tag filter: /?tag={tag}
        ( "/", Nothing, Just tag ) ->
            ( { model
                | search = Just { query = "tag:" ++ tag, results = Loadable Nothing }
                , channel = Nothing
                , episode = episodeId
              }
            , Http.get
                { url = "/search?q=" ++ Url.percentEncode ("tag:" ++ tag)
                , expect = Http.expectJson ChannelsFetched (D.list channelDecoder)
                }
            )

        -- Search mode: /?q=...
        ( "/", Just query, _ ) ->
            case model.search of
                -- Already in search mode, just update query (don't reset results or trigger search)
                Just currentState ->
                    ( { model
                        | search = Just { currentState | query = query }
                        , channel = Nothing
                        , episode = episodeId
                      }
                    , Cmd.none
                    )

                -- Entering search mode fresh
                Nothing ->
                    ( { model
                        | search = Just { query = query, results = Loadable (Just (Ok [])) }
                        , channel = Nothing
                        , episode = episodeId
                      }
                    , if String.isEmpty query then
                        Cmd.none

                      else
                        Http.get
                            { url = "/search?q=" ++ Url.percentEncode query
                            , expect = Http.expectJson ChannelsFetched (D.list channelDecoder)
                            }
                    )

        -- My Feed: /
        ( "/", Nothing, _ ) ->
            ( { model
                | search = Nothing
                , channel = Nothing
                , episode = episodeId
              }
            , Cmd.none
            )

        -- Channel view: /{rss}
        _ ->
            let
                rssEncoded =
                    String.dropLeft 1 url.path

                rss =
                    Url.percentDecode rssEncoded
                        |> Maybe.withDefault rssEncoded
            in
            case model.channel of
                Just ( currentRss, _ ) ->
                    -- Same channel, just update episode
                    if Url.toString currentRss == rss then
                        ( { model | episode = episodeId }, Cmd.none )

                    else
                        loadChannel rss episodeId model

                Nothing ->
                    loadChannel rss episodeId model


loadChannel : String -> Maybe Id -> Model -> ( Model, Cmd Msg )
loadChannel rss episodeId model =
    case ( Url.fromString rss, model.library ) of
        ( Just rssUrl, Loadable (Just (Ok lib)) ) ->
            case Dict.get rss lib.channels of
                Just channel ->
                    let
                        episodes =
                            Dict.get rss lib.episodes
                                |> Maybe.withDefault Dict.empty
                    in
                    if Dict.isEmpty episodes then
                        -- Subscribed but no episodes cached (e.g. subscribed from search) - fetch feed
                        ( { model
                            | channel = Just ( rssUrl, Loadable Nothing )
                            , search = Nothing
                            , episode = Nothing
                          }
                        , Http.get
                            { url = "/proxy/rss/" ++ Url.percentEncode rss
                            , expect = Http.expectString (Result.mapError httpErrorToString >> Result.andThen (X.run feedDecoder) >> FeedFetched rss episodeId)
                            }
                        )

                    else
                        ( { model
                            | channel = Just ( rssUrl, Loadable (Just (Ok { channel = channel, episodes = episodes })) )
                            , search = Nothing
                            , episode = episodeId
                          }
                        , Cmd.none
                        )

                Nothing ->
                    ( { model
                        | channel = Just ( rssUrl, Loadable Nothing )
                        , search = Nothing
                        , episode = Nothing
                      }
                    , Http.get
                        { url = "/proxy/rss/" ++ Url.percentEncode rss
                        , expect = Http.expectString (Result.mapError httpErrorToString >> Result.andThen (X.run feedDecoder) >> FeedFetched rss episodeId)
                        }
                    )

        ( Nothing, _ ) ->
            ( { model | search = Nothing, channel = Nothing }, Cmd.none )

        _ ->
            ( model, Cmd.none )



-- VIEW


view : Model -> Browser.Document Msg
view model =
    { title = "Telecasts"
    , body =
        [ div [ class "rows", id "body" ]
            [ header [ class "cols" ]
                [ div [ class "cols" ] <|
                    List.intersperse (span [] [ text "/" ]) <|
                        List.concat
                            [ [ a [ href "/" ] [ text "telecasts" ] ]
                            , model.search
                                -- TODO: Build url properly or just clear the channel/episode.
                                |> Maybe.map (\{ query } -> [ a [ href ("/?q=" ++ query), class "back" ] [ text ("\"" ++ query ++ "\"") ] ])
                                |> Maybe.withDefault []
                            , model.channel
                                |> Maybe.andThen
                                    (\( rss, loadableFeed ) ->
                                        case loadableFeed of
                                            Loadable (Just (Ok feed)) ->
                                                Just
                                                    [ a [ href ("/" ++ Url.percentEncode (Url.toString rss)) ]
                                                        [ text feed.channel.title ]
                                                    ]

                                            _ ->
                                                Nothing
                                    )
                                |> Maybe.withDefault []
                            ]
                , model.search
                    |> Maybe.map (\_ -> a [ href "?" ] [ text "X" ])
                    |> Maybe.withDefault (a [ href "/?q=" ] [ text "search" ])
                ]
            , case findSelectedEpisode model of
                Just ( episode, maybeChannel ) ->
                    div [ class "rows", id "player-section" ]
                        [ let
                            srcStr =
                                Url.toString episode.src

                            isPeerTubeDownload =
                                String.contains "/download/videos/" srcStr

                            peerTubeEmbedUrl =
                                if isPeerTubeDownload then
                                    episode.id
                                        |> String.replace "/w/" "/videos/embed/"
                                        |> String.replace "/videos/watch/" "/videos/embed/"

                                else
                                    ""
                          in
                          if String.contains "youtube" srcStr then
                            iframe [ id "player", src srcStr, A.width 560, A.height 315, A.autoplay True ] []

                          else if isPeerTubeDownload && String.contains "/videos/embed/" peerTubeEmbedUrl then
                            iframe [ id "player", src peerTubeEmbedUrl, A.width 560, A.height 315, A.autoplay True, A.attribute "allowfullscreen" "true", A.attribute "sandbox" "allow-same-origin allow-scripts allow-popups allow-forms" ] []

                          else if String.endsWith ".mp3" srcStr || String.endsWith ".m4a" srcStr then
                            audio [ id "player", src srcStr, A.controls True, A.autoplay True ] []

                          else
                            video [ id "player", src srcStr, A.controls True, A.autoplay True ] []
                        , div [ id "player-info" ]
                            [ h2 [] [ text episode.title ]
                            , case maybeChannel of
                                Just channel ->
                                    a [ href ("/" ++ Url.percentEncode (Url.toString channel.rss)), class "channel-link" ]
                                        [ text channel.title ]

                                Nothing ->
                                    text ""
                            ]
                        ]

                Nothing ->
                    text ""
            , case ( model.search, model.channel ) of
                ( Just searchState, _ ) ->
                    let
                        heading =
                            if String.isEmpty searchState.query then
                                "My Channels"

                            else if String.startsWith "tag:" searchState.query then
                                searchState.query
                                    |> String.dropLeft 4
                                    |> String.replace "-" " "
                                    |> String.words
                                    |> List.map capitalize
                                    |> String.join " "

                            else
                                "Search: " ++ searchState.query
                    in
                    div [ class "rows", id "search" ]
                        [ h1 [] [ text heading ]
                        , form [ class "cols", onSubmit SearchSubmitting ]
                            [ input
                                [ onInput SearchEditing
                                , value searchState.query
                                , A.placeholder "Search channels..."
                                ]
                                []
                            , button [] [ text "search" ]
                            ]
                        , div [ class "quick-tags" ]
                            (List.map viewTagLink quickSearchTags)
                        , viewLoadable
                            (\channels ->
                                if List.isEmpty channels then
                                    div [ class "empty-state" ] [ text "No channels found" ]

                                else
                                    div [ class "autogrid", id "results" ]
                                        (List.map (viewChannelCard (isLoaded model.library)) channels)
                            )
                            searchState.results
                        ]

                ( _, Just ( rss, loadableFeed ) ) ->
                    div [ class "rows", id "channel" ]
                        (case loadableFeed of
                            Loadable (Just (Ok feed)) ->
                                [ div [ class "rows channel-header" ]
                                    [ div [ class "cols" ]
                                        [ viewThumb "channel-thumb" (channelThumbWithFallback feed.channel.thumb feed.episodes)
                                        , div [ class "rows channel-header-info" ]
                                            [ h1 [] [ text feed.channel.title ]
                                            , div [ class "channel-header-meta" ]
                                                (List.filterMap identity
                                                    [ feed.channel.author |> Maybe.map (\a -> span [] [ text a ])
                                                    , feed.channel.episodeCount |> Maybe.map (\c -> span [] [ text (String.fromInt c ++ " episodes") ])
                                                    ]
                                                    |> List.intersperse (span [ class "meta-sep" ] [ text " · " ])
                                                )
                                            ]
                                        , case model.library of
                                            Loadable (Just (Ok lib)) ->
                                                if Dict.member (Url.toString rss) lib.channels then
                                                    button
                                                        [ onClick (ChannelUnsubscribing (Url.toString rss)) ]
                                                        [ text "unsubscribe" ]

                                                else
                                                    button
                                                        [ onClick (ChannelSubscribing (Url.toString rss) feed.channel) ]
                                                        [ text "subscribe" ]

                                            _ ->
                                                text ""
                                        ]
                                    , p [] [ text feed.channel.description ]
                                    , case feed.channel.categories of
                                        Just cats ->
                                            div [ class "channel-categories" ]
                                                (List.map (\cat -> span [ class "category-tag" ] [ text cat ]) cats)

                                        Nothing ->
                                            text ""
                                    ]
                                , div [ class "autogrid" ]
                                    (Dict.values feed.episodes
                                        |> List.sortBy .index
                                        |> List.map (viewEpisodeCard (isLoaded model.library) (Just rss))
                                    )
                                ]

                            Loadable Nothing ->
                                [ div [ class "loading" ] [] ]

                            Loadable (Just (Err err)) ->
                                [ div [ class "error" ] [ text err ] ]
                        )

                ( Nothing, Nothing ) ->
                    div [ class "rows", id "my-feed" ]
                        [ div [ class "rows" ]
                            [ div [ class "cols" ]
                                [ img [ A.class "profile-img", src "/logo.png" ] []
                                , h1 [] [ text "My Feed" ]
                                , a [ href "/?tag=saved", class "saved-link" ] [ text "my channels" ]
                                ]
                            , p [] [ text "Your watch queue" ]
                            ]
                        , viewLoadable
                            (\lib ->
                                let
                                    queueEpisodes =
                                        lib.queue |> Dict.values |> List.filter (\ep -> not (Set.member ep.id lib.watched))
                                in
                                if List.isEmpty queueEpisodes then
                                    div [ class "empty-state" ] [ text "No episodes in your queue. Subscribe to channels or add episodes with the + button." ]

                                else
                                    div [ class "autogrid" ] (List.map (viewEpisodeCard (Just lib) Nothing) queueEpisodes)
                            )
                            model.library
                        ]
            , div [ id "featured" ]
                [ h2 [] [ text "Discover" ]
                , div [ class "tags" ] (List.map viewTagLink discoverTags)
                ]
            ]
        ]
    }


findSelectedEpisode : Model -> Maybe ( Episode, Maybe Channel )
findSelectedEpisode model =
    model.episode
        |> Maybe.andThen
            (\episodeId ->
                case ( model.channel, model.library ) of
                    ( Just ( _, Loadable (Just (Ok feed)) ), _ ) ->
                        Dict.get episodeId feed.episodes
                            |> Maybe.map (\ep -> ( ep, Just feed.channel ))

                    ( _, Loadable (Just (Ok lib)) ) ->
                        -- Look in queue first (no channel), then in subscribed episodes
                        Dict.get episodeId lib.queue
                            |> Maybe.map (\ep -> Just ( ep, Nothing ))
                            |> Maybe.withDefault
                                -- Find episode and its channel
                                (lib.episodes
                                    |> Dict.toList
                                    |> List.filterMap
                                        (\( rss, eps ) ->
                                            eps
                                                |> Dict.get episodeId
                                                |> Maybe.map (\ep -> ( ep, Dict.get rss lib.channels ))
                                        )
                                    |> List.head
                                )

                    ( _, Loadable _ ) ->
                        Nothing
            )


viewTagLink : ( String, String ) -> Html Msg
viewTagLink ( tag, label ) =
    a [ href ("/?tag=" ++ tag), class "tag" ] [ text label ]


viewEpisodeCard : Maybe Library -> Maybe Url -> Episode -> Html Msg
viewEpisodeCard maybeLib maybeRss episode =
    let
        -- Build episode number prefix like "S2 E5 · " or "E5 · "
        episodePrefix =
            case ( episode.season, episode.episodeNum ) of
                ( Just s, Just e ) ->
                    "S" ++ String.fromInt s ++ " E" ++ String.fromInt e ++ " · "

                ( Nothing, Just e ) ->
                    "E" ++ String.fromInt e ++ " · "

                _ ->
                    ""
    in
    div [ class "episode-card" ]
        [ a [ href (episodeUrl maybeRss episode.id) ]
            [ div [ class "episode-thumb-wrapper" ]
                [ viewThumbInner "episode-thumb" (episodeThumbnail episode)
                , case episode.durationSeconds of
                    Just seconds ->
                        span [ class "duration-badge" ] [ text (formatDuration seconds) ]

                    Nothing ->
                        text ""
                ]
            , div [ class "episode-info" ]
                [ div [ class "episode-title" ]
                    [ text (episodePrefix ++ episode.title) ]
                , case ( maybeRss, episode.channelTitle, episode.publishedAt ) of
                    -- On channel page, only show date
                    ( Just _, _, Just date ) ->
                        div [ class "episode-meta" ] [ text date ]

                    -- In queue/feed, show channel name and date
                    ( Nothing, Just channelName, Just date ) ->
                        div [ class "episode-meta" ] [ text (channelName ++ " · " ++ date) ]

                    ( Nothing, Just channelName, Nothing ) ->
                        div [ class "episode-meta" ] [ text channelName ]

                    ( Nothing, Nothing, Just date ) ->
                        div [ class "episode-meta" ] [ text date ]

                    _ ->
                        text ""
                ]
            ]
        , case maybeLib of
            Just lib ->
                if Set.member episode.id lib.watched then
                    text ""

                else if Dict.member episode.id lib.queue then
                    button [ onClick (EpisodeWatched episode.id) ] [ text "x" ]

                else
                    button [ onClick (EpisodeQueued episode) ] [ text "+" ]

            Nothing ->
                text ""
        ]


{-| Render just the thumbnail image (without wrapper div).
-}
viewThumbInner : String -> Maybe Url -> Html msg
viewThumbInner className maybeUrl =
    case maybeUrl of
        Just url ->
            img
                [ class className
                , src ("/proxy/thumb/" ++ Url.percentEncode (Url.toString url))
                , A.attribute "onerror" "this.parentElement.classList.add('thumb-error')"
                ]
                []

        Nothing ->
            div [ class (className ++ " thumb-placeholder") ] []


{-| Render layered channel thumbnail with blurred background and contained foreground.
Returns a list of elements to be placed directly in the wrapper.
-}
viewChannelThumbLayered : Maybe Url -> List (Html msg)
viewChannelThumbLayered maybeUrl =
    case maybeUrl of
        Just url ->
            let
                urlStr =
                    Url.toString url

                thumbUrl =
                    "/proxy/thumb/" ++ Url.percentEncode urlStr

                isYouTube =
                    String.contains "ytimg.com" urlStr

                fgClass =
                    if isYouTube then
                        "channel-thumb-fg yt-cover"

                    else
                        "channel-thumb-fg"
            in
            [ img
                [ class "channel-thumb-bg"
                , src thumbUrl
                , A.attribute "aria-hidden" "true"
                ]
                []
            , img
                [ class fgClass
                , src thumbUrl
                , A.attribute "onerror" "this.parentElement.classList.add('thumb-error')"
                ]
                []
            ]

        Nothing ->
            [ div [ class "channel-thumb thumb-placeholder" ] [] ]


viewChannelCard : Maybe Library -> Channel -> Html Msg
viewChannelCard maybeLib channel =
    let
        rss =
            Url.toString channel.rss
    in
    div [ class "channel-card" ]
        [ a [ href ("/" ++ Url.percentEncode rss) ]
            [ div [ class "channel-thumb-wrapper" ]
                (viewChannelThumbLayered channel.thumb
                    ++ [ case channel.episodeCount of
                            Just count ->
                                span [ class "episode-count-badge" ] [ text (String.fromInt count ++ " eps") ]

                            Nothing ->
                                text ""
                       ]
                )
            , div [ class "channel-info" ]
                [ div [ class "channel-title" ] [ text channel.title ]
                , case channel.author of
                    Just author ->
                        div [ class "channel-meta" ] [ text author ]

                    Nothing ->
                        text ""
                ]
            ]
        , case maybeLib of
            Just lib ->
                if Dict.member rss lib.channels then
                    button [ onClick (ChannelUnsubscribing rss) ] [ text "x" ]

                else
                    button [ onClick (ChannelSubscribing rss channel) ] [ text "+" ]

            Nothing ->
                button [ onClick (ChannelSubscribing rss channel) ] [ text "+" ]
        ]


channelThumbWithFallback : Maybe Url -> Dict String Episode -> Maybe Url
channelThumbWithFallback channelThumb episodes =
    case channelThumb of
        Just _ ->
            channelThumb

        Nothing ->
            let
                allEpisodes =
                    Dict.values episodes

                -- Prefer non-Shorts episodes for channel thumbnails
                nonShortsThumbs =
                    allEpisodes
                        |> List.filter (isLikelyShort >> not)
                        |> List.filterMap episodeThumbnail

                -- Fallback to any episode thumbnail if all are Shorts
                anyThumb =
                    allEpisodes |> List.filterMap episodeThumbnail
            in
            case nonShortsThumbs of
                first :: _ ->
                    Just first

                [] ->
                    List.head anyThumb


viewThumb : String -> Maybe Url -> Html msg
viewThumb className maybeUrl =
    div [ class (className ++ "-wrapper") ]
        [ viewThumbInner className maybeUrl ]


viewLoadable : (a -> Html msg) -> Loadable a -> Html msg
viewLoadable viewOk loadable =
    case loadable of
        Loadable Nothing ->
            div [ class "loading" ] []

        Loadable (Just (Err err)) ->
            div [ class "error" ] [ text err ]

        Loadable (Just (Ok a)) ->
            viewOk a


quickSearchTags : List ( String, String )
quickSearchTags =
    [ ( "youtube", "YouTube" )
    , ( "video", "Video" )
    , ( "audio", "Audio" )
    , ( "english", "English" )
    , ( "german", "German" )
    , ( "technology", "Tech" )
    , ( "comedy", "Comedy" )
    , ( "science", "Science" )
    ]


discoverTags : List ( String, String )
discoverTags =
    [ ( "conferences", "Conferences" )
    , ( "systems", "Systems" )
    , ( "creative-coding", "Creative Coding" )
    , ( "math", "Math" )
    , ( "physics", "Physics" )
    , ( "chemistry", "Chemistry" )
    , ( "engineering", "Engineering" )
    , ( "electronics", "Electronics" )
    , ( "makers", "Makers" )
    , ( "woodworking", "Woodworking" )
    , ( "restoration", "Restoration" )
    , ( "music-theory", "Music Theory" )
    , ( "music-production", "Production" )
    , ( "synthesizers", "Synthesizers" )
    , ( "musicians", "Musicians" )
    , ( "film-essays", "Film Essays" )
    , ( "game-design", "Game Design" )
    , ( "game-essays", "Game Essays" )
    , ( "video-essays", "Video Essays" )
    , ( "anime", "Anime" )
    , ( "urbanism", "Urbanism" )
    , ( "architecture", "Architecture" )
    , ( "gardening", "Gardening" )
    , ( "cooking", "Cooking" )
    , ( "coffee", "Coffee" )
    , ( "tiny-living", "Tiny Living" )
    , ( "retro-tech", "Retro Tech" )
    , ( "speedrunning", "Speedrunning" )
    , ( "ttrpg", "TTRPG" )
    , ( "comedy", "Comedy" )
    , ( "vtubers", "VTubers" )
    ]



-- ERROR HANDLING


httpErrorToString : Http.Error -> String
httpErrorToString error =
    case error of
        Http.BadUrl url ->
            "Invalid URL: " ++ url

        Http.Timeout ->
            "Request timed out"

        Http.NetworkError ->
            "Network error"

        Http.BadStatus status ->
            "Server error: " ++ String.fromInt status

        Http.BadBody message ->
            "Data error: " ++ message



-- HELPERS


capitalize : String -> String
capitalize str =
    String.uncons str
        |> Maybe.map (\( first, rest ) -> String.cons (Char.toUpper first) rest)
        |> Maybe.withDefault str


{-| Get the best available thumbnail for an episode.
    Prefers 16:9 thumb, falls back to square coverArt.
-}
episodeThumbnail : Episode -> Maybe Url
episodeThumbnail episode =
    case episode.thumb of
        Just url ->
            Just url

        Nothing ->
            episode.coverArt


{-| Format duration in seconds as "1:23:45" or "12:34".
-}
formatDuration : Int -> String
formatDuration seconds =
    let
        h =
            seconds // 3600

        m =
            modBy 60 (seconds // 60)

        s =
            modBy 60 seconds

        pad n =
            if n < 10 then
                "0" ++ String.fromInt n

            else
                String.fromInt n
    in
    if h > 0 then
        String.fromInt h ++ ":" ++ pad m ++ ":" ++ pad s

    else
        String.fromInt m ++ ":" ++ pad s


{-| Check if an episode is a YouTube Short.
    Uses the definitive isShort field (from YouTube's link URL) when available,
    otherwise falls back to title/description heuristics.
-}
isLikelyShort : Episode -> Bool
isLikelyShort episode =
    if episode.isShort then
        -- Definitive: parsed from YouTube's <link rel="alternate"> containing /shorts/
        True

    else
        -- Fallback heuristics for older cached data or non-YouTube feeds
        let
            titleLower =
                String.toLower episode.title

            descLower =
                String.toLower episode.description

            shortsIndicators =
                [ "#shorts", "#short", "#learnwithshorts" ]

            hasIndicator text =
                List.any (\indicator -> String.contains indicator text) shortsIndicators
        in
        hasIndicator titleLower || hasIndicator descLower


getLibrary : Model -> Maybe Library
getLibrary model =
    case model.library of
        Loadable (Just (Ok lib)) ->
            Just lib

        _ ->
            Nothing


{-| Enrich an episode with channel metadata (title and thumbnail).
-}
enrichEpisodeWith : Channel -> Episode -> Episode
enrichEpisodeWith channel ep =
    { ep
        | channelTitle = Just channel.title
        , channelThumb = channel.thumb
    }


episodeUrl : Maybe Url -> Id -> String
episodeUrl maybeRss id =
    case maybeRss of
        Just rss ->
            "/" ++ Url.percentEncode (Url.toString rss) ++ "?e=" ++ Url.percentEncode id

        Nothing ->
            "/?e=" ++ Url.percentEncode id


withLibrary : (Library -> Library) -> Model -> ( Model, Cmd Msg )
withLibrary fn model =
    case model.library of
        Loadable (Just (Ok lib)) ->
            ( { model | library = Loadable (Just (Ok (fn lib))) }
            , librarySaving (libraryEncoder (fn lib))
            )

        _ ->
            ( model, Cmd.none )



-- DECODERS


libraryDecoder : D.Decoder Library
libraryDecoder =
    D.succeed Library
        |> D.required "channels" (D.dict channelDecoder)
        |> D.required "episodes" (D.dict (D.dict episodeDecoder))
        |> D.optional "queue" (D.dict episodeDecoder) Dict.empty
        |> D.optional "watched" (D.list D.string |> D.map Set.fromList) Set.empty
        |> D.required "history" (D.dict (D.dict (D.list playbackDecoder)))
        |> D.required "settings" (D.succeed {})


channelDecoder : D.Decoder Channel
channelDecoder =
    D.succeed Channel
        |> D.required "title" D.string
        |> D.optional "description" D.string ""
        |> thumbWithFallbackDecoder
        |> D.required "rss" urlDecoder
        |> D.required "updated_at" D.string
        |> D.optional "author" (D.maybe D.string) Nothing
        |> D.optional "episode_count" (D.maybe D.int) Nothing
        |> D.optional "categories" (D.maybe (D.list D.string)) Nothing


thumbWithFallbackDecoder : D.Decoder (Maybe Url -> b) -> D.Decoder b
thumbWithFallbackDecoder =
    D.custom
        (D.map2
            (\thumb episodeThumb ->
                case thumb of
                    Just _ ->
                        thumb

                    Nothing ->
                        episodeThumb
            )
            (D.field "thumb" (D.maybe urlDecoder))
            (D.maybe (D.field "episode_thumb" urlDecoder))
        )


episodeDecoder : D.Decoder Episode
episodeDecoder =
    D.succeed Episode
        |> D.required "id" D.string
        |> D.required "title" D.string
        |> D.optional "thumb" (D.maybe urlDecoder) Nothing
        |> D.optional "coverArt" (D.maybe urlDecoder) Nothing
        |> D.required "src" urlDecoder
        |> D.optional "description" D.string ""
        |> D.optional "index" D.int 0
        |> D.optional "durationSeconds" (D.maybe D.int) Nothing
        |> D.optional "publishedAt" (D.maybe D.string) Nothing
        |> D.optional "season" (D.maybe D.int) Nothing
        |> D.optional "episodeNum" (D.maybe D.int) Nothing
        |> D.optional "channelTitle" (D.maybe D.string) Nothing
        |> D.optional "channelThumb" (D.maybe urlDecoder) Nothing
        |> D.optional "isShort" D.bool False
        |> D.optional "viewCount" (D.maybe D.int) Nothing
        |> D.optional "fileSizeBytes" (D.maybe D.int) Nothing
        |> D.optional "isExplicit" D.bool False


playbackDecoder : D.Decoder Playback
playbackDecoder =
    D.succeed Playback
        |> D.required "t" (D.map Time.millisToPosix D.int)
        |> D.required "s"
            (D.map2 Tuple.pair
                (D.index 0 D.int)
                (D.index 1 D.int)
            )


urlDecoder : D.Decoder Url
urlDecoder =
    D.string
        |> D.andThen
            (identity
                >> Url.fromString
                >> Maybe.map D.succeed
                >> Maybe.withDefault (D.fail "Invalid URL")
            )



-- ENCODERS


{-| Encode a Maybe value, using null for Nothing.
-}
encodeMaybe : (a -> E.Value) -> Maybe a -> E.Value
encodeMaybe encode m =
    Maybe.map encode m |> Maybe.withDefault E.null


libraryEncoder : Library -> E.Value
libraryEncoder lib =
    E.object
        [ ( "channels", E.dict identity channelEncoder lib.channels )
        , ( "episodes", E.dict identity (E.dict identity episodeEncoder) lib.episodes )
        , ( "queue", E.dict identity episodeEncoder lib.queue )
        , ( "watched", lib.watched |> Set.toList |> E.list E.string )
        , ( "history", E.dict identity (E.dict identity (E.list playbackEncoder)) lib.history )
        , ( "settings", E.object [] )
        ]


channelEncoder : Channel -> E.Value
channelEncoder channel =
    E.object
        [ ( "title", E.string channel.title )
        , ( "description", E.string channel.description )
        , ( "thumb", encodeMaybe (Url.toString >> E.string) channel.thumb )
        , ( "rss", E.string (Url.toString channel.rss) )
        , ( "updated_at", E.string channel.updatedAt )
        , ( "author", encodeMaybe E.string channel.author )
        , ( "episode_count", encodeMaybe E.int channel.episodeCount )
        , ( "categories", encodeMaybe (E.list E.string) channel.categories )
        ]


episodeEncoder : Episode -> E.Value
episodeEncoder episode =
    E.object
        [ ( "id", E.string episode.id )
        , ( "title", E.string episode.title )
        , ( "thumb", encodeMaybe (Url.toString >> E.string) episode.thumb )
        , ( "coverArt", encodeMaybe (Url.toString >> E.string) episode.coverArt )
        , ( "src", E.string (Url.toString episode.src) )
        , ( "description", E.string episode.description )
        , ( "index", E.int episode.index )
        , ( "durationSeconds", encodeMaybe E.int episode.durationSeconds )
        , ( "publishedAt", encodeMaybe E.string episode.publishedAt )
        , ( "season", encodeMaybe E.int episode.season )
        , ( "episodeNum", encodeMaybe E.int episode.episodeNum )
        , ( "channelTitle", encodeMaybe E.string episode.channelTitle )
        , ( "channelThumb", encodeMaybe (Url.toString >> E.string) episode.channelThumb )
        , ( "isShort", E.bool episode.isShort )
        , ( "viewCount", encodeMaybe E.int episode.viewCount )
        , ( "fileSizeBytes", encodeMaybe E.int episode.fileSizeBytes )
        , ( "isExplicit", E.bool episode.isExplicit )
        ]


playbackEncoder : Playback -> E.Value
playbackEncoder playback =
    E.object
        [ ( "t", E.int (Time.posixToMillis playback.t) )
        , ( "s", E.list E.int [ Tuple.first playback.s, Tuple.second playback.s ] )
        ]



-- XML


urlDecoder_ : String -> X.Decoder Url
urlDecoder_ str =
    let
        trimmed =
            String.trim str
    in
    Url.fromString trimmed
        |> Maybe.map Just
        -- Try with https:// prefix if URL parsing fails
        |> Maybe.withDefault (Url.fromString ("https://" ++ trimmed))
        |> Maybe.map X.succeed
        |> Maybe.withDefault (X.fail ("Invalid URL:" ++ str))


feedDecoder : X.Decoder Feed
feedDecoder =
    X.oneOf
        [ youtubeFormatDecoder
        , podcastRssDecoder
        , standardRssDecoder
        ]


youtubeFormatDecoder : X.Decoder Feed
youtubeFormatDecoder =
    X.map2 Feed
        (X.succeed mkChannel
            |> X.requiredPath [ "title" ] (X.single X.string)
            |> X.optionalPath [ "description" ] (X.single X.string) ""
            |> X.possiblePath [ "thumbnail", "url" ] (X.single (X.string |> X.andThen urlDecoder_))
            |> X.requiredPath [ "author", "uri" ] (X.single (X.string |> X.andThen urlDecoder_))
            |> X.optionalPath [ "published" ] (X.single X.string) "1970-01-01T00:00:00Z"
        )
        (X.path [ "entry" ]
            (X.list youtubeEntryDecoder)
            |> X.map makeEpisodeDict
        )


youtubeEntryDecoder : X.Decoder Episode
youtubeEntryDecoder =
    X.map3
        (\( ( id, title, thumb ), ( src, desc ) ) maybePubDate ( isShort, maybeViews ) ->
            { id = id
            , title = title
            , thumb = thumb
            , coverArt = Nothing -- YouTube doesn't have separate cover art
            , src = src
            , description = desc
            , index = 0
            , durationSeconds = Nothing
            , publishedAt = maybePubDate
            , season = Nothing
            , episodeNum = Nothing
            , channelTitle = Nothing
            , channelThumb = Nothing
            , isShort = isShort
            , viewCount = maybeViews
            , fileSizeBytes = Nothing
            , isExplicit = False
            }
        )
        (X.succeed (\a b c d e -> ( ( a, b, c ), ( d, e ) ))
            |> X.requiredPath [ "id" ] (X.single X.string)
            |> X.requiredPath [ "title" ] (X.single X.string)
            |> X.possiblePath [ "media:group", "media:thumbnail" ]
                (X.single (X.stringAttr "url" |> X.andThen urlDecoder_))
            |> X.requiredPath [ "yt:videoId" ]
                (X.single
                    (X.string
                        |> X.map (\videoId -> "https://www.youtube.com/embed/" ++ videoId)
                        |> X.andThen urlDecoder_
                    )
                )
            |> X.optionalPath [ "media:group", "media:description" ] (X.single X.string) ""
        )
        (X.maybe (X.path [ "published" ] (X.single X.string)))
        -- Shorts detection and view count
        (X.succeed Tuple.pair
            |> X.optionalPath [ "link" ]
                (X.single (X.stringAttr "href" |> X.map (String.contains "/shorts/")))
                False
            |> X.possiblePath [ "media:group", "media:community", "media:statistics" ]
                (X.single (X.stringAttr "views" |> X.map (String.toInt >> Maybe.withDefault 0)))
        )


podcastRssDecoder : X.Decoder Feed
podcastRssDecoder =
    X.map2 Feed
        (X.succeed mkChannel
            |> X.requiredPath [ "channel", "title" ] (X.single X.string)
            |> X.optionalPath [ "channel", "description" ] (X.single X.string) ""
            |> X.possiblePath [ "channel", "image", "url" ] (X.single (X.string |> X.andThen urlDecoder_))
            |> X.requiredPath [ "channel", "link" ] (X.single (X.string |> X.andThen urlDecoder_))
            |> X.optionalPath [ "channel", "lastBuildDate" ] (X.single X.string) ""
        )
        (X.path [ "channel", "item" ]
            (X.list podcastItemDecoder)
            |> X.map makeEpisodeDict
        )


podcastItemDecoder : X.Decoder Episode
podcastItemDecoder =
    itemDecoderWith
        { thumbPath = [ "media:thumbnail" ] -- 16:9 video thumbnail
        , thumbDecoder = X.stringAttr "url" |> X.andThen urlDecoder_
        , coverArtPath = [ "itunes:image" ] -- Square album art
        , coverArtDecoder = X.stringAttr "href" |> X.andThen urlDecoder_
        , srcPath = [ "enclosure" ]
        , srcAsString = X.stringAttr "url"
        , srcAsUrl = X.stringAttr "url" |> X.andThen urlDecoder_
        }


standardRssDecoder : X.Decoder Feed
standardRssDecoder =
    X.map2 Feed
        (X.succeed mkChannel
            |> X.requiredPath [ "channel", "title" ] (X.single X.string)
            |> X.optionalPath [ "channel", "description" ] (X.single X.string) ""
            |> X.possiblePath [ "channel", "image", "url" ] (X.single (X.string |> X.andThen urlDecoder_))
            |> X.requiredPath [ "channel", "link" ] (X.single (X.string |> X.andThen urlDecoder_))
            |> X.optionalPath [ "channel", "pubDate" ] (X.single X.string) ""
        )
        (X.path [ "channel", "item" ]
            (X.list standardItemDecoder)
            |> X.map makeEpisodeDict
        )


{-| Helper for XML decoders: creates base Channel without extra fields.
-}
mkChannel : String -> String -> Maybe Url -> Url -> String -> Channel
mkChannel title description thumb rss updatedAt =
    { title = title
    , description = description
    , thumb = thumb
    , rss = rss
    , updatedAt = updatedAt
    , author = Nothing
    , episodeCount = Nothing
    , categories = Nothing
    }


standardItemDecoder : X.Decoder Episode
standardItemDecoder =
    itemDecoderWith
        { thumbPath = [ "media:thumbnail" ] -- 16:9 video thumbnail (if available)
        , thumbDecoder = X.stringAttr "url" |> X.andThen urlDecoder_
        , coverArtPath = [ "image", "url" ] -- Fallback to standard RSS image
        , coverArtDecoder = X.string |> X.andThen urlDecoder_
        , srcPath = [ "link" ]
        , srcAsString = X.string
        , srcAsUrl = X.string |> X.andThen urlDecoder_
        }


{-| Parse duration string (HH:MM:SS, MM:SS, or raw seconds) to seconds.
-}
parseDuration : String -> Int
parseDuration str =
    let
        parts =
            String.split ":" str |> List.filterMap String.toInt
    in
    case parts of
        [ h, m, s ] ->
            h * 3600 + m * 60 + s

        [ m, s ] ->
            m * 60 + s

        [ s ] ->
            s

        _ ->
            String.toInt str |> Maybe.withDefault 0


parseInt : String -> Int
parseInt str =
    String.toInt str |> Maybe.withDefault 0


itemDecoderWith :
    { thumbPath : List String -- 16:9 video thumbnail (media:thumbnail)
    , thumbDecoder : X.Decoder Url
    , coverArtPath : List String -- Square album art (itunes:image)
    , coverArtDecoder : X.Decoder Url
    , srcPath : List String
    , srcAsString : X.Decoder String
    , srcAsUrl : X.Decoder Url
    }
    -> X.Decoder Episode
itemDecoderWith { thumbPath, thumbDecoder, coverArtPath, coverArtDecoder, srcPath, srcAsString, srcAsUrl } =
    let
        -- Build episode from parsed fields (using nested tuples to avoid Elm's 3-tuple limit)
        buildEpisode ( ( id, title, thumb ), ( coverArt, src, desc ) ) maybeDuration maybePubDate ( maybeSeason, maybeEpNum ) ( maybeFileSize, isExplicit ) =
            { id = id
            , title = title
            , thumb = thumb
            , coverArt = coverArt
            , src = src
            , description = desc
            , index = 0
            , durationSeconds = maybeDuration
            , publishedAt = maybePubDate
            , season = maybeSeason
            , episodeNum = maybeEpNum
            , channelTitle = Nothing
            , channelThumb = Nothing
            , isShort = False
            , viewCount = Nothing
            , fileSizeBytes = maybeFileSize
            , isExplicit = isExplicit
            }

        -- Shared decoders for metadata fields
        durationDecoder =
            X.maybe (X.path [ "itunes:duration" ] (X.single (X.string |> X.map parseDuration)))

        pubDateDecoder =
            X.maybe (X.path [ "pubDate" ] (X.single X.string))

        seasonEpisodeDecoder =
            X.succeed Tuple.pair
                |> X.possiblePath [ "itunes:season" ] (X.single (X.string |> X.map parseInt))
                |> X.possiblePath [ "itunes:episode" ] (X.single (X.string |> X.map parseInt))

        fileSizeExplicitDecoder =
            X.succeed Tuple.pair
                |> X.possiblePath [ "enclosure" ] (X.single (X.stringAttr "length" |> X.map (String.toInt >> Maybe.withDefault 0)))
                |> X.optionalPath [ "itunes:explicit" ] (X.single (X.string |> X.map isExplicitValue)) False

        -- Core fields decoder with a given ID source
        coreFieldsWithId idPath idDecoder_ =
            X.succeed (\a b c d e f -> ( ( a, b, c ), ( d, e, f ) ))
                |> X.requiredPath idPath (X.single idDecoder_)
                |> X.requiredPath [ "title" ] (X.single X.string)
                |> X.possiblePath thumbPath (X.single thumbDecoder)
                |> X.possiblePath coverArtPath (X.single coverArtDecoder)
                |> X.requiredPath srcPath (X.single srcAsUrl)
                |> X.optionalPath [ "description" ] (X.single X.string) ""
    in
    X.oneOf
        [ X.map5 buildEpisode
            (coreFieldsWithId [ "guid" ] X.string)
            durationDecoder
            pubDateDecoder
            seasonEpisodeDecoder
            fileSizeExplicitDecoder
        , X.map5 buildEpisode
            (coreFieldsWithId srcPath srcAsString)
            durationDecoder
            pubDateDecoder
            seasonEpisodeDecoder
            fileSizeExplicitDecoder
        ]


{-| Parse itunes:explicit value - can be "true", "yes", "1" or "false", "no", "0".
-}
isExplicitValue : String -> Bool
isExplicitValue str =
    List.member (String.toLower str) [ "true", "yes", "1" ]


makeEpisodeDict : List Episode -> Dict Id Episode
makeEpisodeDict episodes =
    episodes
        |> List.indexedMap (\i ep -> ( ep.id, { ep | index = i } ))
        |> Dict.fromList
