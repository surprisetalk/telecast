port module Main exposing (main)

import Browser
import Browser.Navigation as Nav
import Char
import Dict exposing (Dict)
import Set exposing (Set)
import Html exposing (..)
import Html.Attributes as A exposing (class, href, id, src, value)
import Html.Events exposing (onClick, onInput, onSubmit)
import Http
import Json.Decode as D
import Json.Decode.Pipeline as D
import Json.Encode as E
import Task
import Time
import Url exposing (Url)
import Url.Parser as P exposing ((</>), Parser)
import Xml.Decode as X



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
        |> D.required "thumb" (D.maybe urlDecoder)
        |> D.required "rss" urlDecoder
        |> D.required "updated_at" D.string


episodeDecoder : D.Decoder Episode
episodeDecoder =
    D.succeed Episode
        |> D.required "id" D.string
        |> D.required "title" D.string
        |> D.required "thumb" (D.maybe urlDecoder)
        |> D.required "src" urlDecoder
        |> D.optional "description" D.string ""


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
            (\str ->
                case Url.fromString str of
                    Just url ->
                        D.succeed url

                    Nothing ->
                        D.fail "Invalid URL"
            )



-- ENCODERS


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
        , ( "thumb", channel.thumb |> Maybe.map (\u -> E.string (Url.toString u)) |> Maybe.withDefault E.null )
        , ( "rss", E.string (Url.toString channel.rss) )
        , ( "updated_at", E.string channel.updatedAt )
        ]


episodeEncoder : Episode -> E.Value
episodeEncoder episode =
    E.object
        [ ( "id", E.string episode.id )
        , ( "title", E.string episode.title )
        , ( "thumb", episode.thumb |> Maybe.map (\u -> E.string (Url.toString u)) |> Maybe.withDefault E.null )
        , ( "src", E.string (Url.toString episode.src) )
        , ( "description", E.string episode.description )
        ]


playbackEncoder : Playback -> E.Value
playbackEncoder playback =
    E.object
        [ ( "t", E.int (Time.posixToMillis playback.t) )
        , ( "s", E.list E.int [ Tuple.first playback.s, Tuple.second playback.s ] )
        ]


-- PORTS


port libraryLoaded : (D.Value -> msg) -> Sub msg


port librarySaving : E.Value -> Cmd msg



-- TYPES


type alias Id =
    String


type Loadable a
    = Loadable (Maybe (Result String a))


type alias Model =
    { library : Loadable Library
    , key : Nav.Key
    , view : ViewState
    , episode : Maybe Id -- episode ID
    }


type ViewState
    = ViewMyFeed
    | ViewChannel Url (Loadable Feed)
    | ViewSearch SearchState


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
    }


type alias Episode =
    { id : Id
    , title : String
    , thumb : Maybe Url
    , src : Url
    , description : String
    }



-- INIT


init : D.Value -> Url -> Nav.Key -> ( Model, Cmd Msg )
init flags url key =
    let
        library =
            flags
                |> D.decodeValue libraryDecoder
                |> Result.mapError (always "Could not parse library.")
                |> Just
                |> Loadable
    in
    route url
        { library = library
        , key = key
        , view = ViewMyFeed
        , episode = Nothing
        }



-- SUBSCRIPTIONS


subscriptions : Model -> Sub Msg
subscriptions model =
    Sub.batch
        [ libraryLoaded (D.decodeValue libraryDecoder >> LibraryLoaded)
        ]



-- UPDATE


update : Msg -> Model -> ( Model, Cmd Msg )
update msg model =
    case msg of
        LibraryLoaded (Ok lib) ->
            ( { model | library = Loadable (Just (Ok lib)) }
            , Cmd.none
            )

        LibraryLoaded (Err _) ->
            ( { model | library = Loadable (Just (Err "Could not load library.")) }
            , Cmd.none
            )

        FeedFetched originalRss maybeEpisodeId result ->
            case result of
                Ok feed ->
                    let
                        oldChannel =
                            feed.channel

                        correctedFeed =
                            case Url.fromString originalRss of
                                Just parsedRssUrl ->
                                    { feed | channel = { oldChannel | rss = parsedRssUrl } }

                                Nothing ->
                                    feed

                        finalRssUrl =
                            Url.fromString originalRss
                                |> Maybe.withDefault correctedFeed.channel.rss
                    in
                    ( { model
                        | view = ViewChannel finalRssUrl (Loadable (Just (Ok correctedFeed)))
                        , episode = maybeEpisodeId
                      }
                    , Cmd.none
                    )

                Err err ->
                    case model.view of
                        ViewChannel rssUrl _ ->
                            ( { model | view = ViewChannel rssUrl (Loadable (Just (Err err))) }
                            , Cmd.none
                            )

                        _ ->
                            ( model, Cmd.none )

        ChannelsFetched result ->
            case model.view of
                ViewSearch searchState ->
                    case result of
                        Ok channels ->
                            let
                                filteredChannels =
                                    case model.library of
                                        Loadable (Just (Ok lib)) ->
                                            Dict.values lib.channels
                                                |> List.filter (\c -> String.contains (String.toLower searchState.query) (String.toLower c.title))
                                                |> List.append channels

                                        _ ->
                                            channels
                            in
                            ( { model | view = ViewSearch { searchState | results = Loadable (Just (Ok filteredChannels)) } }
                            , Cmd.none
                            )

                        Err err ->
                            ( { model | view = ViewSearch { searchState | results = Loadable (Just (Err (httpErrorToString err))) } }
                            , Cmd.none
                            )

                _ ->
                    ( model, Cmd.none )

        SearchEditing query ->
            case model.view of
                ViewSearch searchState ->
                    ( { model | view = ViewSearch { searchState | query = query } }
                    , Nav.replaceUrl model.key ("/?q=" ++ Url.percentEncode query)
                    )

                _ ->
                    ( model, Cmd.none )

        SearchSubmitting ->
            case model.view of
                ViewSearch searchState ->
                    ( { model | view = ViewSearch { searchState | results = Loadable Nothing } }
                    , Cmd.batch
                        [ Nav.pushUrl model.key ("/?q=" ++ Url.percentEncode searchState.query)
                        , Http.get
                            { url = "/search?q=" ++ Url.percentEncode searchState.query
                            , expect = Http.expectJson ChannelsFetched (D.list channelDecoder)
                            }
                        ]
                    )

                _ ->
                    ( model, Cmd.none )

        ChannelSubscribing channelId ->
            case model.view of
                ViewChannel _ (Loadable (Just (Ok feed))) ->
                    let
                        -- Add most recent 3 episodes to queue
                        recentEpisodes =
                            feed.episodes
                                |> Dict.values
                                |> List.take 3
                                |> List.map (\ep -> ( ep.id, ep ))
                                |> Dict.fromList
                    in
                    withLibrary
                        (\lib ->
                            { lib
                                | channels = Dict.insert channelId feed.channel lib.channels
                                , episodes = Dict.insert channelId feed.episodes lib.episodes
                                , queue = Dict.union recentEpisodes lib.queue
                            }
                        )
                        model

                _ ->
                    ( model, Cmd.none )

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
                (\lib ->
                    { lib | queue = Dict.insert episode.id episode lib.queue }
                )
                model

        EpisodeWatched episodeId ->
            withLibrary
                (\lib ->
                    { lib | watched = Set.insert episodeId lib.watched }
                )
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



-- VIEW


view : Model -> Browser.Document Msg
view model =
    { title = "Telecasts"
    , body =
        [ div [ class "rows", id "body" ]
            [ viewHeader model
            , viewPlayerSection model
            , viewMain model
            , viewFeatured
            ]
        ]
    }


viewPlayerSection : Model -> Html Msg
viewPlayerSection model =
    case findSelectedEpisode model of
        Just ( episode, maybeChannel ) ->
            div [ class "rows", id "player-section" ]
                [ viewPlayer episode
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


findSelectedEpisode : Model -> Maybe ( Episode, Maybe Channel )
findSelectedEpisode model =
    case model.episode of
        Nothing ->
            Nothing

        Just episodeId ->
            case model.view of
                ViewChannel _ (Loadable (Just (Ok feed))) ->
                    Dict.get episodeId feed.episodes
                        |> Maybe.map (\ep -> ( ep, Just feed.channel ))

                ViewMyFeed ->
                    case model.library of
                        Loadable (Just (Ok lib)) ->
                            -- Look in queue first (no channel), then in subscribed episodes
                            case Dict.get episodeId lib.queue of
                                Just ep ->
                                    Just ( ep, Nothing )

                                Nothing ->
                                    -- Find episode and its channel
                                    lib.episodes
                                        |> Dict.toList
                                        |> List.filterMap
                                            (\( rss, eps ) ->
                                                Dict.get episodeId eps
                                                    |> Maybe.map (\ep -> ( ep, Dict.get rss lib.channels ))
                                            )
                                        |> List.head

                        _ ->
                            Nothing

                _ ->
                    Nothing


viewHeader : Model -> Html Msg
viewHeader model =
    header [ class "cols" ]
        [ div [ class "cols" ]
            [ case model.view of
                ViewChannel _ _ ->
                    button [ onClick GoBack, class "back" ] [ text "<" ]

                ViewSearch _ ->
                    button [ onClick GoBack, class "back" ] [ text "<" ]

                _ ->
                    text ""
            , a [ href "/" ] [ text "telecasts" ]
            ]
        , case model.view of
            ViewSearch _ ->
                text ""

            _ ->
                a [ href "/?q=" ] [ text "search" ]
        ]


viewMain : Model -> Html Msg
viewMain model =
    case model.view of
        ViewMyFeed ->
            viewMyFeed model

        ViewChannel rss loadableFeed ->
            viewChannelPage rss loadableFeed model

        ViewSearch searchState ->
            viewSearchPage searchState model


viewMyFeed : Model -> Html Msg
viewMyFeed model =
    div [ class "rows", id "my-feed" ]
        [ div [ class "rows" ]
            [ div [ class "cols" ]
                [ img [ A.class "profile-img", src "/logo.png" ] []
                , h1 [] [ text "My Feed" ]
                , a [ href "/?tag=saved", class "saved-link" ] [ text "my channels" ]
                ]
            , p [] [ text "Your watch queue" ]
            ]
        , case model.library of
            Loadable (Just (Ok lib)) ->
                let
                    -- Only show queue episodes (not watched)
                    queueEpisodes =
                        lib.queue
                            |> Dict.values
                            |> List.filter (\ep -> not (Set.member ep.id lib.watched))
                in
                if List.isEmpty queueEpisodes then
                    div [ class "empty-state" ] [ text "No episodes in your queue. Subscribe to channels or add episodes with the + button." ]

                else
                    div [ class "autogrid" ]
                        (List.map (viewEpisodeCard lib Nothing) queueEpisodes)

            Loadable Nothing ->
                div [ class "loading" ] []

            Loadable (Just (Err err)) ->
                div [ class "error" ] [ text err ]
        ]


viewFeatured : Html Msg
viewFeatured =
    div [ id "featured" ]
        [ h2 [] [ text "Discover" ]
        , div [ class "tags" ]
            (List.map viewTagLink
                [ ( "tech-talks", "Tech Talks" )
                , ( "standup", "Stand-up Comedy" )
                , ( "interviews", "Interviews" )
                , ( "documentaries", "Documentaries" )
                , ( "music", "Music" )
                , ( "gaming", "Gaming" )
                , ( "science", "Science" )
                , ( "history", "History" )
                , ( "cooking", "Cooking" )
                , ( "fitness", "Fitness" )
                , ( "news", "News" )
                , ( "film-analysis", "Film Analysis" )
                , ( "philosophy", "Philosophy" )
                , ( "true-crime", "True Crime" )
                , ( "diy", "DIY & Crafts" )
                , ( "language", "Language Learning" )
                ]
            )
        ]


viewTagLink : ( String, String ) -> Html Msg
viewTagLink ( tag, label ) =
    a [ href ("/?tag=" ++ tag), class "tag" ] [ text label ]


viewChannelPage : Url -> Loadable Feed -> Model -> Html Msg
viewChannelPage rssUrl loadableFeed model =
    let
        rss =
            Url.toString rssUrl
    in
    div [ class "rows", id "channel" ]
        (case loadableFeed of
            Loadable (Just (Ok feed)) ->
                [ div [ class "rows" ]
                    [ div [ class "cols" ]
                        [ case feed.channel.thumb of
                            Just thumbUrl ->
                                img [ A.class "channel-thumb", src (Url.toString thumbUrl) ] []

                            Nothing ->
                                text ""
                        , h1 [] [ text feed.channel.title ]
                        , viewSubscribeButton rss model
                        ]
                    , p [] [ text feed.channel.description ]
                    ]
                , case model.library of
                    Loadable (Just (Ok lib)) ->
                        div [ class "autogrid" ]
                            (Dict.values feed.episodes
                                |> List.map (viewEpisodeCard lib (Just rssUrl))
                            )

                    _ ->
                        div [ class "autogrid" ]
                            (Dict.values feed.episodes
                                |> List.map (viewEpisodeCardSimple rssUrl)
                            )
                ]

            Loadable Nothing ->
                [ div [ class "loading" ] [] ]

            Loadable (Just (Err err)) ->
                [ div [ class "error" ] [ text err ] ]
        )


viewSubscribeButton : String -> Model -> Html Msg
viewSubscribeButton rss model =
    case model.library of
        Loadable (Just (Ok lib)) ->
            if Dict.member rss lib.channels then
                button
                    [ onClick (ChannelUnsubscribing rss) ]
                    [ text "unsubscribe" ]

            else
                button
                    [ onClick (ChannelSubscribing rss) ]
                    [ text "subscribe" ]

        _ ->
            text ""


viewSearchPage : SearchState -> Model -> Html Msg
viewSearchPage searchState model =
    let
        heading =
            if String.isEmpty searchState.query then
                "My Channels"

            else if String.startsWith "pack:" searchState.query then
                searchState.query
                    |> String.dropLeft 5
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
        , case searchState.results of
            Loadable Nothing ->
                div [ class "loading" ] []

            Loadable (Just (Ok [])) ->
                div [ class "empty-state" ] [ text "No channels found" ]

            Loadable (Just (Ok channels)) ->
                div [ class "autogrid", id "results" ]
                    (List.map (viewChannelCard model) channels)

            Loadable (Just (Err err)) ->
                div [ class "error" ] [ text err ]
        ]


viewEpisodeCard : Library -> Maybe Url -> Episode -> Html Msg
viewEpisodeCard lib maybeRss episode =
    let
        isWatched =
            Set.member episode.id lib.watched

        isQueued =
            Dict.member episode.id lib.queue

        episodeUrl =
            case maybeRss of
                Just rss ->
                    "/" ++ Url.percentEncode (Url.toString rss) ++ "?e=" ++ Url.percentEncode episode.id

                Nothing ->
                    "/?e=" ++ Url.percentEncode episode.id
    in
    div [ class "episode-card" ]
        [ a [ href episodeUrl ]
            [ case episode.thumb of
                Just thumbUrl ->
                    img [ class "episode-thumb", src (Url.toString thumbUrl) ] []

                Nothing ->
                    div [ class "episode-thumb-placeholder" ] []
            , div [ class "episode-title" ] [ text episode.title ]
            ]
        , if isWatched then
            text ""

          else if isQueued then
            button [ onClick (EpisodeWatched episode.id), class "watched-btn" ] [ text "x" ]

          else
            button [ onClick (EpisodeQueued episode), class "queue-btn" ] [ text "+" ]
        ]


viewEpisodeCardSimple : Url -> Episode -> Html Msg
viewEpisodeCardSimple rss episode =
    let
        episodeUrl =
            "/" ++ Url.percentEncode (Url.toString rss) ++ "?e=" ++ Url.percentEncode episode.id
    in
    div [ class "episode-card" ]
        [ a [ href episodeUrl ]
            [ case episode.thumb of
                Just thumbUrl ->
                    img [ class "episode-thumb", src (Url.toString thumbUrl) ] []

                Nothing ->
                    div [ class "episode-thumb-placeholder" ] []
            , div [ class "episode-title" ] [ text episode.title ]
            ]
        ]


viewChannelCard : Model -> Channel -> Html Msg
viewChannelCard model channel =
    let
        rss =
            Url.toString channel.rss

        isSubscribed =
            case model.library of
                Loadable (Just (Ok lib)) ->
                    Dict.member rss lib.channels

                _ ->
                    False
    in
    div [ class "channel-card" ]
        [ a [ href ("/" ++ Url.percentEncode rss) ]
            [ case channel.thumb of
                Just thumbUrl ->
                    img [ class "channel-thumb", src (Url.toString thumbUrl) ] []

                Nothing ->
                    div [ class "channel-thumb-placeholder" ] []
            , div [ class "channel-title" ] [ text channel.title ]
            ]
        , if isSubscribed then
            button [ onClick (ChannelUnsubscribing rss), class "unsub-btn" ] [ text "x" ]

          else
            button [ onClick (ChannelSubscribing rss), class "sub-btn" ] [ text "+" ]
        ]


viewPlayer : Episode -> Html Msg
viewPlayer episode =
    let
        srcStr =
            Url.toString episode.src

        isYoutube =
            String.contains "youtube" srcStr

        isPeerTubeDownload =
            String.contains "/download/videos/" srcStr

        isAudio =
            String.endsWith ".mp3" srcStr || String.endsWith ".m4a" srcStr

        peerTubeEmbedUrl =
            if isPeerTubeDownload then
                episode.id
                    |> String.replace "/w/" "/videos/embed/"
                    |> String.replace "/videos/watch/" "/videos/embed/"

            else
                ""
    in
    if isYoutube then
        iframe
            [ id "player"
            , src srcStr
            , A.width 560
            , A.height 315
            , A.autoplay True
            ]
            []

    else if isPeerTubeDownload && String.contains "/videos/embed/" peerTubeEmbedUrl then
        iframe
            [ id "player"
            , src peerTubeEmbedUrl
            , A.width 560
            , A.height 315
            , A.autoplay True
            , A.attribute "allowfullscreen" "true"
            , A.attribute "sandbox" "allow-same-origin allow-scripts allow-popups allow-forms"
            ]
            []

    else if isAudio then
        audio
            [ id "player"
            , src srcStr
            , A.controls True
            , A.autoplay True
            ]
            []

    else
        video
            [ id "player"
            , src srcStr
            , A.controls True
            ]
            []



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



-- MSG


type Msg
    = LibraryLoaded (Result D.Error Library)
    | FeedFetched String (Maybe Id) (Result String Feed)
    | ChannelsFetched (Result Http.Error (List Channel))
    | SearchEditing String
    | SearchSubmitting
    | ChannelSubscribing String
    | ChannelUnsubscribing String
    | EpisodeQueued Episode
    | EpisodeWatched Id
    | GoBack
    | LinkClicked Browser.UrlRequest
    | UrlChanged Url



-- ROUTING


route : Url -> Model -> ( Model, Cmd Msg )
route url model =
    let
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
            let
                savedChannels =
                    case model.library of
                        Loadable (Just (Ok lib)) ->
                            Dict.values lib.channels

                        _ ->
                            []
            in
            ( { model
                | view = ViewSearch { query = "", results = Loadable (Just (Ok savedChannels)) }
                , episode = episodeId
              }
            , Cmd.none
            )

        -- Tag/pack filter: /?tag={tag}
        ( "/", Nothing, Just tag ) ->
            ( { model
                | view = ViewSearch { query = "pack:" ++ tag, results = Loadable Nothing }
                , episode = episodeId
              }
            , Http.get
                { url = "/search?q=" ++ Url.percentEncode ("pack:" ++ tag)
                , expect = Http.expectJson ChannelsFetched (D.list channelDecoder)
                }
            )

        -- Search mode: /?q=...
        ( "/", Just query, _ ) ->
            case model.view of
                -- Already in search mode, just update query (don't reset results or trigger search)
                ViewSearch currentState ->
                    ( { model
                        | view = ViewSearch { currentState | query = query }
                        , episode = episodeId
                      }
                    , Cmd.none
                    )

                -- Entering search mode fresh
                _ ->
                    ( { model
                        | view = ViewSearch { query = query, results = Loadable (Just (Ok [])) }
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
                | view = ViewMyFeed
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
            case model.view of
                ViewChannel currentRss _ ->
                    -- Same channel, just update episode
                    if Url.toString currentRss == rss then
                        ( { model | episode = episodeId }, Cmd.none )

                    else
                        loadChannel rss episodeId model

                _ ->
                    loadChannel rss episodeId model


loadChannel : String -> Maybe Id -> Model -> ( Model, Cmd Msg )
loadChannel rss episodeId model =
    case Url.fromString rss of
        Nothing ->
            ( { model | view = ViewMyFeed }, Cmd.none )

        Just rssUrl ->
            case model.library of
                Loadable (Just (Ok lib)) ->
                    case Dict.get rss lib.channels of
                        Just channel ->
                            let
                                episodes =
                                    Dict.get rss lib.episodes
                                        |> Maybe.withDefault Dict.empty
                            in
                            ( { model
                                | view = ViewChannel rssUrl (Loadable (Just (Ok { channel = channel, episodes = episodes })))
                                , episode = episodeId
                              }
                            , Cmd.none
                            )

                        Nothing ->
                            ( { model
                                | view = ViewChannel rssUrl (Loadable Nothing)
                                , episode = Nothing
                              }
                            , Http.get
                                { url = "/proxy/rss/" ++ Url.percentEncode rss
                                , expect = Http.expectString (Result.mapError httpErrorToString >> Result.andThen (X.run feedDecoder) >> FeedFetched rss episodeId)
                                }
                            )

                _ ->
                    ( model, Cmd.none )


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



-- HELPERS


capitalize : String -> String
capitalize str =
    case String.uncons str of
        Just ( first, rest ) ->
            String.cons (Char.toUpper first) rest

        Nothing ->
            str


withLibrary : (Library -> Library) -> Model -> ( Model, Cmd Msg )
withLibrary fn model =
    case model.library of
        Loadable (Just (Ok lib)) ->
            let
                newLib =
                    fn lib
            in
            ( { model | library = Loadable (Just (Ok newLib)) }
            , librarySaving (libraryEncoder newLib)
            )

        _ ->
            ( model, Cmd.none )



-- XML


feedDecoder : X.Decoder Feed
feedDecoder =
    X.oneOf
        [ youtubeFormatDecoder
        , podcastRssDecoder
        , standardRssDecoder
        ]


urlDecoder_ : String -> X.Decoder Url
urlDecoder_ str =
    let
        trimmed =
            String.trim str

        -- Try with https:// prefix if URL parsing fails
        maybeUrl =
            case Url.fromString trimmed of
                Just url ->
                    Just url

                Nothing ->
                    Url.fromString ("https://" ++ trimmed)
    in
    case maybeUrl of
        Just url ->
            X.succeed url

        Nothing ->
            X.fail ("Invalid URL: " ++ str)


youtubeFormatDecoder : X.Decoder Feed
youtubeFormatDecoder =
    X.map2 Feed
        (X.succeed Channel
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
    X.succeed Episode
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


podcastRssDecoder : X.Decoder Feed
podcastRssDecoder =
    X.map2 Feed
        (X.succeed Channel
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
        { thumbPath = [ "itunes:image" ]
        , thumbDecoder = X.stringAttr "href" |> X.andThen urlDecoder_
        , srcPath = [ "enclosure" ]
        , srcAsString = X.stringAttr "url"
        , srcAsUrl = X.stringAttr "url" |> X.andThen urlDecoder_
        }


standardRssDecoder : X.Decoder Feed
standardRssDecoder =
    X.map2 Feed
        (X.succeed Channel
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


standardItemDecoder : X.Decoder Episode
standardItemDecoder =
    itemDecoderWith
        { thumbPath = [ "image", "url" ]
        , thumbDecoder = X.string |> X.andThen urlDecoder_
        , srcPath = [ "link" ]
        , srcAsString = X.string
        , srcAsUrl = X.string |> X.andThen urlDecoder_
        }


itemDecoderWith :
    { thumbPath : List String
    , thumbDecoder : X.Decoder Url
    , srcPath : List String
    , srcAsString : X.Decoder String
    , srcAsUrl : X.Decoder Url
    }
    -> X.Decoder Episode
itemDecoderWith { thumbPath, thumbDecoder, srcPath, srcAsString, srcAsUrl } =
    X.oneOf
        [ X.succeed Episode
            |> X.requiredPath [ "guid" ] (X.single X.string)
            |> X.requiredPath [ "title" ] (X.single X.string)
            |> X.possiblePath thumbPath (X.single thumbDecoder)
            |> X.requiredPath srcPath (X.single srcAsUrl)
            |> X.optionalPath [ "description" ] (X.single X.string) ""
        , X.succeed Episode
            |> X.requiredPath srcPath (X.single srcAsString)
            |> X.requiredPath [ "title" ] (X.single X.string)
            |> X.possiblePath thumbPath (X.single thumbDecoder)
            |> X.requiredPath srcPath (X.single srcAsUrl)
            |> X.optionalPath [ "description" ] (X.single X.string) ""
        ]



-- Helper function to convert a list of episodes to a Dict


makeEpisodeDict : List Episode -> Dict Id Episode
makeEpisodeDict episodes =
    episodes
        |> List.map (\episode -> ( episode.id, episode ))
        |> Dict.fromList
