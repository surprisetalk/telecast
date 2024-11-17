port module Main exposing (main)

import Browser
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Http
import Json.Decode as D
import Rss exposing (Feed)
import Url



-- PORTS


port saveToLocalStorageChannels : Feed -> Cmd msg


port removeFromLocalStorageChannels : Feed -> Cmd msg


port saveToLocalStorageEpisodes : Feed -> Cmd msg


port subsLoaded : (List Feed -> msg) -> Sub msg



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
    { errors : List String
    , query : String
    , channels : List Channel
    , feed : Maybe Feed
    , episode : Maybe Episode
    , subs : List Feed
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
    ( { errors = []
      , query = ""
      , channels = []
      , feed = Nothing
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
    | FeedClicking Feed
    | ChannelFetched (Result Http.Error String)
    | EpisodeClicking Episode
    | ChannelSubbing Feed
    | ChannelUnsubbing Feed
    | SubsLoaded (List Feed)
    | SubFetching Channel
    | SubFetched Channel (Result Http.Error Feed)


update : Msg -> Model -> ( Model, Cmd Msg )
update msg model =
    case msg of
        SearchEditing query ->
            ( { model | query = query }, Cmd.none )

        SearchSubmitting ->
            ( { model | channels = [], feed = Nothing }
            , Http.get
                { url = "/api/channels?q=" ++ model.query
                , expect = Http.expectJson ChannelsFetched channelsDecoder
                }
            )

        ChannelsFetched (Ok channels) ->
            ( { model | channels = channels, feed = Nothing }, Cmd.none )

        ChannelsFetched (Err err) ->
            ( { model | errors = Debug.toString err :: model.errors }, Cmd.none )

        ChannelClicking channel ->
            ( { model | feed = Nothing }
            , Http.get
                { url = "/api/proxy/rss?url=" ++ Url.percentEncode channel.rss
                , expect = Http.expectString ChannelFetched
                }
            )

        FeedClicking feed ->
            ( { model | feed = Just feed }, Cmd.none )

        ChannelFetched (Ok xml) ->
            case Rss.decodeFeed xml of
                Ok feed ->
                    ( { model | feed = Just feed }, Cmd.none )

                Err err ->
                    ( { model | errors = err :: model.errors }, Cmd.none )

        ChannelFetched (Err err) ->
            ( { model | errors = Debug.toString err :: model.errors }, Cmd.none )

        EpisodeClicking episode ->
            ( { model | episode = Just episode }, Cmd.none )

        ChannelSubbing feed ->
            ( model, saveToLocalStorageChannels feed )

        ChannelUnsubbing channel ->
            ( model, removeFromLocalStorageChannels channel )

        SubsLoaded subs ->
            ( { model | subs = subs }, Cmd.none )

        SubFetching channel ->
            ( model
            , Http.get
                { url = "/api/proxy/rss?url=" ++ Url.percentEncode channel.rss
                , expect = Http.expectString ChannelFetched
                }
            )

        SubFetched channel (Ok feed) ->
            ( model, saveToLocalStorageEpisodes feed )

        SubFetched _ (Err _) ->
            ( model, Cmd.none )



-- SUBSCRIPTIONS


subscriptions : Model -> Sub Msg
subscriptions _ =
    subsLoaded SubsLoaded



-- VIEW


view : Model -> Html Msg
view model =
    div []
        [ viewErrors model
        , main_ []
            [ viewChannels model
            , viewFeed model
            , viewEpisode model
            ]
        ]


viewErrors : Model -> Html Msg
viewErrors model =
    model.errors |> List.map (\err -> p [] [ text err ]) |> div []


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
            , div [] (List.map viewFeedButton model.subs)
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


viewFeedButton : Feed -> Html Msg
viewFeedButton feed =
    button
        [ class "cols"
        , onClick (FeedClicking feed)
        ]
        [ img [ src feed.thumbnail ] []
        , p [] [ text feed.title ]
        ]


viewFeed : Model -> Html Msg
viewFeed model =
    div [ class "rows", id "channel" ] <|
        case model.feed of
            Nothing ->
                []

            Just feed ->
                [ div [ class "rows" ]
                    [ div [ class "cols" ]
                        -- [ img [ src feed.thumbnail ] []
                        -- , h2 [] [ text feed.title ]
                        -- ]
                        [ h2 [] [ text feed.title ] ]
                    , if List.member feed model.subs then
                        button [ onClick (ChannelUnsubbing feed) ]
                            [ text "unsubscribe" ]

                      else
                        button [ onClick (ChannelSubbing feed) ]
                            [ text "subscribe" ]
                    ]
                , div [] (List.map viewEpisodeButton (Maybe.withDefault [] <| Maybe.map .episodes model.feed))
                ]


viewEpisodeButton : Episode -> Html Msg
viewEpisodeButton episode =
    button
        [ class "rows"
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
                    [ iframe
                        [ src episode.src
                        , width 640
                        , height 360
                        , attribute "frameborder" "0"
                        , attribute "allow" "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                        , attribute "allowfullscreen" "true"
                        , attribute "loading" "lazy"
                        ]
                        []
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
