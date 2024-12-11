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
import Url.Builder as B
import Url.Parser as P exposing ((</>), Parser)



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


feedDecoder : D.Decoder Feed
feedDecoder =
    D.succeed Feed
        |> D.required "channel" channelDecoder
        |> D.required "episodes" (D.dict episodeDecoder)


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
                    ( { model | channels = Loadable (Just (Err (Debug.toString err))) }
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
    ul [ id "search-results" ]
        (case model.channels of
            Loadable Nothing ->
                [ text "Loading..." ]

            Loadable (Just (Ok channels)) ->
                List.map viewChannelItem channels

            Loadable (Just (Err err)) ->
                [ text ("Error: " ++ err) ]
        )


viewLibrary : Model -> Html Msg
viewLibrary model =
    ul [ id "library" ]
        (li [] [ a [ href "//" ] [ text "My Subscriptions" ] ]
            :: (case model.library of
                    Loadable (Just (Ok lib)) ->
                        Dict.values lib.channels
                            |> List.map viewChannelItem

                    _ ->
                        []
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
                , ul [ id "episodes" ]
                    (Dict.values feed.episodes
                        |> List.map (viewEpisodeItem feed.channel.rss)
                    )
                ]

            Loadable Nothing ->
                [ text "Loading..." ]

            Loadable (Just (Err err)) ->
                [ text ("Error: " ++ err) ]

            _ ->
                [ text "Select a channel" ]
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
        [ a [ href ("/" ++ Url.percentEncode (Url.toString rss) ++ "/" ++ episode.id) ]
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
                        [ text "Episode not found" ]

            _ ->
                []
        )


viewPlayer : Episode -> Html Msg
viewPlayer episode =
    let
        isYoutube =
            String.contains "youtube" (Url.toString episode.src)
    in
    if isYoutube then
        iframe
            [ id "player"
            , src (Url.toString episode.src)
            , A.width 560
            , A.height 315
            ]
            []

    else
        video
            [ id "player"
            , src (Url.toString episode.src)
            , A.controls True
            ]
            []



-- HELPERS


relativeTime : Time.Posix -> String
relativeTime timestamp =
    let
        now =
            Time.millisToPosix (Time.posixToMillis timestamp + 1000)

        -- temporary mock current time
        diff =
            Time.posixToMillis now - Time.posixToMillis timestamp

        minutes =
            diff // 60000

        hours =
            minutes // 60

        days =
            hours // 24
    in
    if diff < 60000 then
        "just now"

    else if minutes < 60 then
        String.fromInt minutes ++ " minutes ago"

    else if hours < 24 then
        String.fromInt hours ++ " hours ago"

    else
        String.fromInt days ++ " days ago"


filterChannels : String -> List Channel -> List Channel
filterChannels query channels =
    let
        lowerQuery =
            String.toLower query

        matchesQuery channel =
            String.contains lowerQuery (String.toLower channel.title)
                || String.contains lowerQuery (String.toLower channel.description)
    in
    List.filter matchesQuery channels


isSubscribed : String -> Library -> Bool
isSubscribed rss lib =
    Dict.member rss lib.channels


getEpisodeFromModel : Model -> Maybe Episode
getEpisodeFromModel model =
    case ( model.channel, model.episode ) of
        ( Loadable (Just (Ok (Just feed))), Just episodeId ) ->
            Dict.get episodeId feed.episodes

        _ ->
            Nothing



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
    | FeedFetched (Maybe String) (Result Http.Error Feed)
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
                            , Http.get
                                { url = "/proxy/rss/" ++ rss
                                , expect = Http.expectJson (FeedFetched mEid) feedDecoder
                                }
                            )

                        Nothing ->
                            ( { model
                                | channel = Loadable Nothing
                                , episode = Nothing
                              }
                            , Http.get
                                { url = "/proxy/rss/" ++ rss
                                , expect = Http.expectJson (FeedFetched mEid) feedDecoder
                                }
                            )

                _ ->
                    ( model, Cmd.none )
    in
    url
        |> P.parse
            (P.oneOf
                [ (P.string </> P.oneOf [ P.string |> P.map Just, P.top |> P.map Nothing ])
                    |> P.map
                        (\rss mEid ->
                            case model.channel of
                                Loadable (Just (Ok (Just feed))) ->
                                    if Url.toString feed.channel.rss == rss then
                                        ( { model | episode = mEid }, Cmd.none )

                                    else
                                        loadChannel rss mEid

                                _ ->
                                    loadChannel rss mEid
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
