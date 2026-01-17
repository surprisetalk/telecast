port module Main exposing (main)

import Browser
import Browser.Navigation as Nav
import Dict exposing (Dict)
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



{-
   feedDecoder : D.Decoder Feed
   feedDecoder =
       D.succeed Feed
           |> D.required "channel" channelDecoder
           |> D.required "episodes" (D.dict episodeDecoder)
-}


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
        , ( "history", E.dict identity (E.dict identity (E.list playbackEncoder)) lib.history )
        , ( "settings", E.object [] )
        ]


channelEncoder : Channel -> E.Value
channelEncoder channel =
    E.object
        [ ( "title", E.string channel.title )
        , ( "description", E.string channel.description )
        , ( "thumb", channel.thumb |> Maybe.map urlEncoder |> Maybe.withDefault E.null )
        , ( "rss", urlEncoder channel.rss )
        , ( "updated_at", E.string channel.updatedAt )
        ]


episodeEncoder : Episode -> E.Value
episodeEncoder episode =
    E.object
        [ ( "id", E.string episode.id )
        , ( "title", E.string episode.title )
        , ( "thumb", episode.thumb |> Maybe.map urlEncoder |> Maybe.withDefault E.null )
        , ( "src", urlEncoder episode.src )
        , ( "description", E.string episode.description )
        ]


playbackEncoder : Playback -> E.Value
playbackEncoder playback =
    E.object
        [ ( "t", E.int (Time.posixToMillis playback.t) )
        , ( "s", E.list E.int [ Tuple.first playback.s, Tuple.second playback.s ] )
        ]


urlEncoder : Url -> E.Value
urlEncoder url =
    E.string (Url.toString url)



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
    , query : String
    , channels : Loadable (List Channel)
    , channel : Loadable (Maybe Feed)
    , episode : Maybe Id
    , key : Nav.Key
    }


type alias Feed =
    { channel : Channel
    , episodes : Dict Id Episode
    }


type alias Library =
    { channels : Dict String Channel
    , episodes : Dict Id (Dict Id Episode)
    , history : Dict Id (Dict Id (List Playback))
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
    route url
        { library =
            flags
                |> D.decodeValue libraryDecoder
                |> Result.mapError (always "Could not parse library.")
                |> Just
                |> Loadable
        , query = ""
        , channels = Loadable (Just (Ok []))
        , channel = Loadable (Just (Ok Nothing))
        , episode = Nothing
        , key = key
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

        FeedFetched maybeEpisodeId result ->
            case result of
                Ok feed ->
                    ( { model
                        | channel = Loadable (Just (Ok (Just feed)))
                        , episode = maybeEpisodeId
                      }
                    , Cmd.none
                    )

                Err err ->
                    ( { model | channel = Loadable (Just (Err (Debug.toString err))) }
                    , Cmd.none
                    )

        ChannelsFetched result ->
            case result of
                Ok channels ->
                    let
                        filteredChannels =
                            case model.library of
                                Loadable (Just (Ok lib)) ->
                                    Dict.values lib.channels
                                        |> List.filter (\c -> String.contains (String.toLower c.title) (String.toLower model.query))
                                        |> List.append channels

                                _ ->
                                    channels
                    in
                    ( { model | channels = Loadable (Just (Ok filteredChannels)) }
                    , Cmd.none
                    )

                Err err ->
                    ( { model | channels = Loadable (Just (Err (httpErrorToString err))) }
                    , Cmd.none
                    )

        SearchEditing query ->
            ( { model | query = query }
            , Cmd.none
            )

        SearchSubmitting ->
            ( { model | channels = Loadable Nothing }
            , Http.get
                { url = "/search?q=" ++ Url.percentEncode model.query
                , expect = Http.expectJson ChannelsFetched (D.list channelDecoder)
                }
            )

        PackSelecting packId ->
            ( { model | query = "pack:" ++ packId }
            , Task.perform (\_ -> SearchSubmitting) (Task.succeed ())
            )

        ChannelSubscribing channelId ->
            case model.channel of
                Loadable (Just (Ok (Just feed))) ->
                    withLibrary
                        (\lib ->
                            { lib
                                | channels = Dict.insert channelId feed.channel lib.channels
                                , episodes = Dict.insert channelId feed.episodes lib.episodes
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
    { title = "Podcast Player"
    , body =
        [ div [ class "cols" ]
            [ viewChannels model
            , viewChannel model
            , viewEpisode model
            ]
        ]
    }


viewChannels : Model -> Html Msg
viewChannels model =
    div [ class "rows", id "channels" ]
        [ img [ id "logo", src "/logo.png" ] []
        , form [ id "search", onSubmit SearchSubmitting ]
            [ input
                [ onInput SearchEditing
                , value model.query
                ]
                []
            , button [] [ text "search" ]
            , ul [ id "packs" ]
                -- TODO
                [ li [] [ a [ href "/", onClick (PackSelecting "news") ] [ text "News" ] ]
                ]
            ]
        , viewSearchResults model
        , viewLibrary model
        ]


viewSearchResults : Model -> Html Msg
viewSearchResults model =
    ul [ id "search-results", class "custom-scrollbar" ]
        (case model.channels of
            Loadable Nothing ->
                [ li [] [ div [ class "loading" ] [] ] ]

            Loadable (Just (Ok [])) ->
                [ li [ class "empty-state" ] [ text "No results found" ] ]

            Loadable (Just (Ok channels)) ->
                List.map viewChannelItem channels

            Loadable (Just (Err err)) ->
                [ li [] [ div [ class "error" ] [ text err ] ] ]
        )


viewLibrary : Model -> Html Msg
viewLibrary model =
    ul [ id "library", class "custom-scrollbar" ]
        (li [] [ a [ href "/" ] [ text "My Subscriptions" ] ]
            :: (case model.library of
                    Loadable Nothing ->
                        [ li [] [ div [ class "loading" ] [] ] ]

                    Loadable (Just (Ok lib)) ->
                        if Dict.isEmpty lib.channels then
                            [ li [ class "empty-state" ] [ text "No subscriptions yet" ] ]

                        else
                            Dict.values lib.channels
                                |> List.map viewChannelItem

                    Loadable (Just (Err err)) ->
                        [ li [] [ div [ class "error" ] [ text err ] ] ]
               )
        )


viewChannelItem : Channel -> Html Msg
viewChannelItem channel =
    li []
        [ a [ href ("/" ++ Url.percentEncode (Url.toString channel.rss)) ]
            [ text channel.title ]
        ]


viewChannel : Model -> Html Msg
viewChannel model =
    div [ class "rows", id "channel" ]
        (case model.channel of
            Loadable (Just (Ok (Just feed))) ->
                [ div [ id "channel-details" ]
                    [ h1 [] [ text feed.channel.title ]
                    , p [] [ text ("Last updated " ++ feed.channel.updatedAt) ]
                    , viewSubscribeButton feed.channel.rss model
                    , p [] [ text feed.channel.description ]
                    ]
                , ul [ id "episodes", class "custom-scrollbar" ]
                    (Dict.values feed.episodes
                        |> List.map (viewEpisodeItem feed.channel.rss)
                    )
                ]

            Loadable Nothing ->
                [ div [ class "loading" ] [] ]

            Loadable (Just (Err err)) ->
                [ div [ class "error" ] [ text err ] ]

            _ ->
                [ div [ class "empty-state" ] [ text "Select a channel" ] ]
        )


viewSubscribeButton : Url -> Model -> Html Msg
viewSubscribeButton rss_ model =
    let
        rss =
            Url.toString rss_
    in
    case model.library of
        Loadable (Just (Ok lib)) ->
            if Dict.member rss lib.channels then
                button
                    [ onClick (ChannelUnsubscribing rss) ]
                    [ text "Unsubscribe" ]

            else
                button
                    [ onClick (ChannelSubscribing rss) ]
                    [ text "Subscribe" ]

        _ ->
            text ""


viewEpisodeItem : Url -> Episode -> Html Msg
viewEpisodeItem rss episode =
    li []
        [ a [ href ("/" ++ Url.percentEncode (Url.toString rss) ++ "/" ++ Url.percentEncode episode.id) ]
            [ text episode.title ]
        ]


viewEpisode : Model -> Html Msg
viewEpisode model =
    div [ class "rows", id "episode" ]
        (case model.channel of
            Loadable (Just (Ok (Just feed))) ->
                case model.episode |> Maybe.andThen (\eid -> Dict.get eid feed.episodes) of
                    Just episode ->
                        [ viewPlayer episode
                        , h1 [] [ text episode.title ]
                        , h2 [] [ text feed.channel.title ]
                        ]

                    Nothing ->
                        [ div [ class "empty-state" ] [ text "Select an episode to play" ] ]

            _ ->
                [ div [ class "empty-state" ] [ text "Select an episode to play" ] ]
        )


viewPlayer : Episode -> Html Msg
viewPlayer episode =
    let
        srcStr =
            Url.toString episode.src

        isYoutube =
            String.contains "youtube" srcStr

        isAudio =
            String.endsWith ".mp3" srcStr || String.endsWith ".m4a" srcStr
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
    | FeedFetched (Maybe String) (Result String Feed)
    | ChannelsFetched (Result Http.Error (List Channel))
    | SearchEditing String
    | SearchSubmitting
    | PackSelecting String
    | ChannelSubscribing String
    | ChannelUnsubscribing String
    | LinkClicked Browser.UrlRequest
    | UrlChanged Url



-- ROUTING


route : Url -> Model -> ( Model, Cmd Msg )
route url model =
    let
        -- TODO: Inline this
        loadChannel : String -> Maybe String -> ( Model, Cmd Msg )
        loadChannel rss mEid =
            case model.library of
                Loadable (Just (Ok lib)) ->
                    case Dict.get rss lib.channels of
                        Just channel ->
                            ( { model
                                | channel = Loadable (Just (Ok (Just { channel = channel, episodes = Dict.get rss lib.episodes |> Maybe.withDefault Dict.empty })))
                                , episode = mEid
                              }
                            , Cmd.none
                            )

                        Nothing ->
                            ( { model
                                | channel = Loadable Nothing
                                , episode = Nothing
                              }
                            , Http.get
                                { url = "/proxy/rss/" ++ rss
                                , expect = Http.expectString (Result.mapError httpErrorToString >> Result.andThen (X.run feedDecoder) >> FeedFetched mEid)
                                }
                            )

                _ ->
                    ( model, Cmd.none )
    in
    url
        |> P.parse
            (P.oneOf
                [ (P.s "all" </> P.oneOf [ P.string |> P.map Just, P.top |> P.map Nothing ])
                    |> P.map
                        (\mEid ->
                            case model.library of
                                Loadable (Just (Ok lib)) ->
                                    ( { model
                                        | channel =
                                            let
                                                channel : Channel
                                                channel =
                                                    { title = "My Subscriptions"
                                                    , description = ""
                                                    , thumb = Nothing
                                                    , rss = { protocol = Url.Https, host = "localhost", port_ = Nothing, path = "/all", query = Nothing, fragment = Nothing }
                                                    , updatedAt = ""
                                                    }
                                            in
                                            -- TODO: List first N episodes.
                                            Loadable (Just (Ok (Just { channel = channel, episodes = Dict.empty })))
                                        , episode = Nothing
                                      }
                                    , Cmd.none
                                    )

                                _ ->
                                    ( model, Cmd.none )
                        )
                , (P.string </> P.oneOf [ P.string |> P.map Just, P.top |> P.map Nothing ])
                    |> P.map
                        (\rss mEid ->
                            let
                                decodedEid =
                                    Maybe.andThen Url.percentDecode mEid
                            in
                            case model.channel of
                                Loadable (Just (Ok (Just feed))) ->
                                    if Url.percentDecode (Url.toString feed.channel.rss) == Url.percentDecode rss then
                                        ( { model | episode = decodedEid }, Cmd.none )

                                    else
                                        loadChannel rss decodedEid

                                _ ->
                                    loadChannel rss decodedEid
                        )
                ]
            )
        |> Maybe.withDefault ( { model | channel = Loadable (Just (Ok Nothing)), episode = Nothing }, Cmd.none )



-- MODEL HELPERS


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
    case Url.fromString str of
        Just url ->
            X.succeed url

        Nothing ->
            X.fail "Invalid URL"


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
    X.succeed Episode
        |> X.requiredPath [ "guid" ] (X.single X.string)
        |> X.requiredPath [ "title" ] (X.single X.string)
        |> X.possiblePath [ "itunes:image" ] (X.single (X.stringAttr "href" |> X.andThen urlDecoder_))
        |> X.requiredPath [ "enclosure" ] (X.single (X.stringAttr "url" |> X.andThen urlDecoder_))
        |> X.optionalPath [ "description" ] (X.single X.string) ""


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
    X.succeed Episode
        |> X.requiredPath [ "guid" ] (X.single X.string)
        |> X.requiredPath [ "title" ] (X.single X.string)
        |> X.possiblePath [ "image", "url" ] (X.single (X.string |> X.andThen urlDecoder_))
        |> X.requiredPath [ "link" ] (X.single (X.string |> X.andThen urlDecoder_))
        |> X.optionalPath [ "description" ] (X.single X.string) ""



-- Helper function to convert a list of episodes to a Dict


makeEpisodeDict : List Episode -> Dict Id Episode
makeEpisodeDict episodes =
    episodes
        |> List.map (\episode -> ( episode.id, episode ))
        |> Dict.fromList
