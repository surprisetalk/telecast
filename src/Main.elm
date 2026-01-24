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


type alias Model =
    { library : Loadable Library
    , key : Nav.Key
    , channel : Maybe ( Url, Loadable Feed )
    , search : Maybe SearchState
    , episode : Maybe Id -- episode ID
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
    }


type alias Episode =
    { id : Id
    , title : String
    , thumb : Maybe Url
    , src : Url
    , description : String
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
    | ChannelSubscribing String
    | ChannelUnsubscribing String
    | EpisodeQueued Episode
    | EpisodeWatched Id
    | GoBack
    | LinkClicked Browser.UrlRequest
    | UrlChanged Url



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

        ChannelSubscribing channelId ->
            case model.channel of
                Just ( _, Loadable (Just (Ok feed)) ) ->
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
                                |> Maybe.map
                                    (\( _, _ ) ->
                                        -- TODO: Build urls properly.
                                        [ a [ href ("/" ++ "TODO") ] [ text "TODO" ]
                                        , a [ href ("/" ++ "TODO") ] [ text "TODO" ]
                                        ]
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
                            video [ id "player", src srcStr, A.controls True ] []
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

                ( _, Just ( rss, loadableFeed ) ) ->
                    div [ class "rows", id "channel" ]
                        (case loadableFeed of
                            Loadable (Just (Ok feed)) ->
                                [ div [ class "rows" ]
                                    [ div [ class "cols" ]
                                        [ viewThumb "channel-thumb" (channelThumbWithFallback feed.channel.thumb feed.episodes)
                                        , h1 [] [ text feed.channel.title ]
                                        , case model.library of
                                            Loadable (Just (Ok lib)) ->
                                                if Dict.member (Url.toString rss) lib.channels then
                                                    button
                                                        [ onClick (ChannelUnsubscribing (Url.toString rss)) ]
                                                        [ text "unsubscribe" ]

                                                else
                                                    button
                                                        [ onClick (ChannelSubscribing (Url.toString rss)) ]
                                                        [ text "subscribe" ]

                                            _ ->
                                                text ""
                                        ]
                                    , p [] [ text feed.channel.description ]
                                    ]
                                , case model.library of
                                    Loadable (Just (Ok lib)) ->
                                        div [ class "autogrid" ]
                                            (Dict.values feed.episodes
                                                |> List.map (viewEpisodeCard lib (Just rss))
                                            )

                                    _ ->
                                        div [ class "autogrid" ]
                                            (Dict.values feed.episodes
                                                |> List.map
                                                    (\episode ->
                                                        div [ class "episode-card" ]
                                                            [ a [ href (episodeUrl (Just rss) episode.id) ]
                                                                [ viewThumb "episode-thumb" episode.thumb
                                                                , div [ class "episode-title" ] [ text episode.title ]
                                                                ]
                                                            ]
                                                    )
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
                                    div [ class "autogrid" ] (List.map (viewEpisodeCard lib Nothing) queueEpisodes)
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


viewEpisodeCard : Library -> Maybe Url -> Episode -> Html Msg
viewEpisodeCard lib maybeRss episode =
    div [ class "episode-card" ]
        [ a [ href (episodeUrl maybeRss episode.id) ]
            [ viewThumb "episode-thumb" episode.thumb
            , div [ class "episode-title" ] [ text episode.title ]
            ]
        , if Set.member episode.id lib.watched then
            text ""

          else if Dict.member episode.id lib.queue then
            button [ onClick (EpisodeWatched episode.id), class "watched-btn" ] [ text "x" ]

          else
            button [ onClick (EpisodeQueued episode), class "queue-btn" ] [ text "+" ]
        ]


viewChannelCard : Model -> Channel -> Html Msg
viewChannelCard model channel =
    let
        rss =
            Url.toString channel.rss
    in
    div [ class "channel-card" ]
        [ a [ href ("/" ++ Url.percentEncode rss) ]
            [ viewThumb "channel-thumb" channel.thumb
            , div [ class "channel-title" ] [ text channel.title ]
            ]
        , case model.library of
            Loadable (Just (Ok lib)) ->
                if Dict.member rss lib.channels then
                    button [ onClick (ChannelUnsubscribing rss), class "unsub-btn" ] [ text "x" ]

                else
                    button [ onClick (ChannelSubscribing rss), class "sub-btn" ] [ text "+" ]

            _ ->
                button [ onClick (ChannelSubscribing rss), class "sub-btn" ] [ text "+" ]
        ]


channelThumbWithFallback : Maybe Url -> Dict String Episode -> Maybe Url
channelThumbWithFallback channelThumb episodes =
    case channelThumb of
        Just _ ->
            channelThumb

        Nothing ->
            Dict.values episodes
                |> List.head
                |> Maybe.andThen .thumb


viewThumb : String -> Maybe Url -> Html msg
viewThumb className maybeUrl =
    div [ class (className ++ "-wrapper") ]
        [ case maybeUrl of
            Just url ->
                img
                    [ class className
                    , src ("/proxy/thumb/" ++ Url.percentEncode (Url.toString url))
                    , A.attribute "onerror" "this.parentElement.classList.add('thumb-error')"
                    ]
                    []

            Nothing ->
                div [ class (className ++ " thumb-placeholder") ] []
        ]


viewLoadable : (a -> Html msg) -> Loadable a -> Html msg
viewLoadable viewOk loadable =
    case loadable of
        Loadable Nothing ->
            div [ class "loading" ] []

        Loadable (Just (Err err)) ->
            div [ class "error" ] [ text err ]

        Loadable (Just (Ok a)) ->
            viewOk a


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


getLibrary : Model -> Maybe Library
getLibrary model =
    case model.library of
        Loadable (Just (Ok lib)) ->
            Just lib

        _ ->
            Nothing


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
            (identity
                >> Url.fromString
                >> Maybe.map D.succeed
                >> Maybe.withDefault (D.fail "Invalid URL")
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


makeEpisodeDict : List Episode -> Dict Id Episode
makeEpisodeDict episodes =
    episodes
        |> List.map (\episode -> ( episode.id, episode ))
        |> Dict.fromList
