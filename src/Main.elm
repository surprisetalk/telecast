port module Main exposing (main)

import Browser
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Http
import Json.Decode as D
import Set exposing (Set)
import Task



-- PORTS


port saveToLocalStorageChannels : Channel -> Cmd msg


port removeFromLocalStorageChannels : Channel -> Cmd msg


port saveToLocalStorageEpisodes : { sub : Channel, feed : Feed } -> Cmd msg


port subsLoaded : (List Channel -> msg) -> Sub msg



-- MAIN


main : Program () Model Msg
main =
    Browser.element
        { init = init
        , update = update
        , subscriptions = subscriptions
        , view = view
        }



-- MODEL


type alias Model =
    { query : String
    , channels : List Channel
    , episodes : List Episode
    , channel : Maybe Channel
    , episode : Maybe Episode
    , subs : List Channel
    }


type alias Channel =
    { title : String
    , thumbnail : String
    , rss : String
    }


type alias Episode =
    { title : String
    , thumbnail : String
    , src : String
    , description : String
    }


init : () -> ( Model, Cmd Msg )
init _ =
    ( { query = ""
      , channels = []
      , episodes = []
      , channel = Nothing
      , episode = Nothing
      , subs = []
      }
    , Cmd.none
    )



-- UPDATE


type Msg
    = SearchEditing String
    | SearchSubmitting
    | ChannelsFetched (Result Http.Error (List Channel))
    | ChannelClicking Channel
    | ChannelFetched (Result Http.Error Feed)
    | EpisodeClicking Episode
    | ChannelSubbing Channel
    | ChannelUnsubbing Channel
    | SubsLoaded (List Channel)
    | SubFetching Channel
    | SubFetched Channel (Result Http.Error Feed)


update : Msg -> Model -> ( Model, Cmd Msg )
update msg model =
    case msg of
        SearchEditing query ->
            ( { model | query = query }, Cmd.none )

        SearchSubmitting ->
            ( { model | channels = [], episodes = [] }
            , Http.get
                { url = "/channels?q=" ++ model.query
                , expect = Http.expectJson ChannelsFetched channelsDecoder
                }
            )

        ChannelsFetched (Ok channels) ->
            ( { model | channels = channels, episodes = [] }, Cmd.none )

        ChannelsFetched (Err _) ->
            ( model, Cmd.none )

        ChannelClicking channel ->
            ( { model | channel = Just channel, episodes = [] }
            , Http.get
                { url = channel.rss
                , expect = Http.expectJson ChannelFetched feedDecoder
                }
            )

        ChannelFetched (Ok feed) ->
            ( { model | episodes = feed.episodes }, Cmd.none )

        ChannelFetched (Err _) ->
            ( model, Cmd.none )

        EpisodeClicking episode ->
            ( { model | episode = Just episode }, Cmd.none )

        ChannelSubbing channel ->
            ( model, saveToLocalStorageChannels channel )

        ChannelUnsubbing channel ->
            ( model, removeFromLocalStorageChannels channel )

        SubsLoaded subs ->
            ( { model | subs = subs }, Cmd.none )

        SubFetching channel ->
            ( model
            , Http.get
                { url = channel.rss
                , expect = Http.expectJson (SubFetched channel) feedDecoder
                }
            )

        SubFetched channel (Ok feed) ->
            ( model, saveToLocalStorageEpisodes { sub = channel, feed = feed } )

        SubFetched _ (Err _) ->
            ( model, Cmd.none )



-- SUBSCRIPTIONS


subscriptions : Model -> Sub Msg
subscriptions _ =
    subsLoaded SubsLoaded



-- VIEW


view : Model -> Html Msg
view model =
    main_ []
        [ viewChannels model
        , viewChannel model
        , viewEpisode model
        ]


viewChannels : Model -> Html Msg
viewChannels model =
    div [ class "rows", id "channels" ]
        [ a [ href "/" ] [ h1 [] [ text "telecasts" ] ]
        , div [ class "rows" ]
            [ Html.form [ class "cols", onSubmit SearchSubmitting ]
                [ input
                    [ class "cols"
                    , value model.query
                    , onInput SearchEditing
                    ]
                    []
                , button [] [ text "search" ]
                ]
            , div [] (List.map viewChannelButton model.channels)
            , div [] (List.map viewChannelButton model.subs)
            ]
        ]


viewChannelButton : Channel -> Html Msg
viewChannelButton channel =
    button
        [ class "cols"
        , onClick (ChannelClicking channel)
        ]
        [ img [ src channel.thumbnail ] []
        , p [] [ text channel.title ]
        ]


viewChannel : Model -> Html Msg
viewChannel model =
    div [ class "rows", id "channel" ] <|
        case model.channel of
            Nothing ->
                []

            Just channel ->
                [ div [ class "rows" ]
                    [ div [ class "cols" ]
                        [ img [ src channel.thumbnail ] []
                        , h2 [] [ text channel.title ]
                        ]
                    , if List.member channel model.subs then
                        button [ onClick (ChannelUnsubbing channel) ]
                            [ text "unsubscribe" ]

                      else
                        button [ onClick (ChannelSubbing channel) ]
                            [ text "subscribe" ]
                    ]
                , div [] (List.map viewEpisodeButton model.episodes)
                ]


viewEpisodeButton : Episode -> Html Msg
viewEpisodeButton episode =
    button
        [ class "cols"
        , onClick (EpisodeClicking episode)
        ]
        [ img [ src episode.thumbnail ] []
        , p [] [ text episode.title ]
        ]


viewEpisode : Model -> Html Msg
viewEpisode model =
    div [ class "rows", id "episode" ] <|
        case model.episode of
            Nothing ->
                []

            Just episode ->
                [ div [ class "rows" ]
                    [ video [ src episode.src ] []
                    , div [ class "rows" ]
                        [ h3 [] [ text episode.title ]
                        , p [] [ text episode.description ]
                        ]
                    ]
                ]



-- DECODERS


channelsDecoder : D.Decoder (List Channel)
channelsDecoder =
    D.list
        (D.map3 Channel
            (D.field "title" D.string)
            (D.field "thumbnail" D.string)
            (D.field "rss" D.string)
        )


type alias Feed =
    { episodes : List Episode
    }


feedDecoder : D.Decoder Feed
feedDecoder =
    D.map Feed
        (D.field "episodes"
            (D.list
                (D.map4 Episode
                    (D.field "title" D.string)
                    (D.field "thumbnail" D.string)
                    (D.field "src" D.string)
                    (D.field "description" D.string)
                )
            )
        )
