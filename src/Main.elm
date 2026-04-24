port module Main exposing (..)

import Browser
import Browser.Dom
import Browser.Events
import Browser.Navigation as Nav
import Char
import Dict exposing (Dict)
import Html exposing (..)
import Html.Attributes as A exposing (class, href, id, src, title, value)
import Html.Events exposing (onClick, onInput, onSubmit)
import Http
import Json.Decode as D
import Json.Decode.Pipeline as D
import Json.Encode as E
import Process
import Set exposing (Set)
import Task
import Time
import Url exposing (Url)
import Url.Parser as P exposing ((</>), (<?>), Parser)
import Url.Parser.Query as Q
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
    , discoverPending : Maybe { pending : Set String, buffer : List DiscoverEpisode } -- batched discover refresh
    , feedSnapshot : Maybe (List Episode) -- snapshot of queue on My Feed entry; sticky across watched marks
    , featured : Loadable (List Channel)
    , showHistory : Bool
    , playerError : Maybe Id
    }


type alias DiscoverEpisode =
    { rss : Url
    , episode : Episode
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
    , watchHistory : List Episode -- most recently played first, capped
    , featured : List Channel -- cached tag:featured channels for bar
    , discover : List DiscoverEpisode -- cached recent episodes from featured channels for dimmed fill
    , discoverAt : Maybe Int -- posix millis of last discover refresh
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
    let
        ( m, cmd ) =
            route url
                (initModel flags key)
    in
    ( m
    , Cmd.batch
        [ cmd
        , Http.get
            { url = "/search?q=tag:featured"
            , expect = Http.expectJson FeaturedFetched (D.list channelDecoder)
            }
        , Task.perform (always RefreshFeeds) (Task.succeed ())
        ]
    )


initModel : D.Value -> Nav.Key -> Model
initModel flags key =
    let
        decoded =
            flags
                |> D.decodeValue libraryDecoder
                |> Result.mapError (always "Could not parse library.")

        cachedFeatured =
            case decoded of
                Ok lib ->
                    if List.isEmpty lib.featured then
                        Loadable Nothing

                    else
                        Loadable (Just (Ok lib.featured))

                Err _ ->
                    Loadable Nothing
    in
    { library = Loadable (Just decoded)
    , key = key
    , channel = Nothing
    , search = Nothing
    , episode = Nothing
    , refreshing = Nothing
    , discoverPending = Nothing
    , feedSnapshot = Nothing
    , featured = cachedFeatured
    , showHistory = False
    , playerError = Nothing
    }



-- SUBSCRIPTIONS


subscriptions : Model -> Sub Msg
subscriptions _ =
    Sub.batch
        [ libraryLoaded (D.decodeValue libraryDecoder >> LibraryLoaded)
        , Browser.Events.onKeyDown
            (D.field "key" D.string
                |> D.andThen
                    (\key ->
                        D.at [ "target", "tagName" ] D.string
                            |> D.andThen
                                (\tag ->
                                    if tag == "INPUT" || tag == "TEXTAREA" then
                                        D.fail "ignore"

                                    else
                                        D.succeed (KeyPressed key)
                                )
                    )
            )
        ]



-- MSG


type Msg
    = LibraryLoaded (Result D.Error Library)
    | FeedFetched String (Maybe Id) (Result String Feed)
    | ChannelsFetched (Result Http.Error (List Channel))
    | SearchEditing String
    | SearchDebounced String
    | SearchSubmitting
    | ChannelSubscribing String Channel
    | InitialFeedFetched String Channel (Result String Feed)
    | ChannelUnsubscribing String
    | EpisodeQueued Episode
    | EpisodeWatched Id
    | SearchUrlFetched String (Result String Feed)
    | FeaturedFetched (Result Http.Error (List Channel))
    | DiscoverFeedFetched Url (Result String Feed)
    | MaybeRefreshDiscover Time.Posix
    | LinkClicked Browser.UrlRequest
    | UrlChanged Url
    | RefreshFeeds
    | RefreshFeedFetched String (Result String Feed)
    | ChannelRetrying String
    | PlayerFailed Id
    | PlayerRetrying
    | KeyPressed String
    | NoOp



-- UPDATE


update : Msg -> Model -> ( Model, Cmd Msg )
update msg model =
    case msg of
        LibraryLoaded (Ok lib) ->
            ( { model
                | library = Loadable (Just (Ok lib))
                , featured =
                    if List.isEmpty lib.featured then
                        model.featured

                    else
                        Loadable (Just (Ok lib.featured))
              }
            , if model.refreshing == Nothing then
                Task.perform (always RefreshFeeds) (Task.succeed ())

              else
                Cmd.none
            )

        LibraryLoaded (Err _) ->
            ( { model | library = Loadable (Just (Err "Could not load library.")) }
            , Cmd.none
            )

        FeedFetched originalRss maybeEpisodeId (Ok feed) ->
            let
                rssUrl =
                    Url.fromString originalRss |> Maybe.withDefault feed.channel.rss

                correctedFeed =
                    { feed | channel = (\c -> { c | rss = rssUrl }) feed.channel }

                isStale =
                    case model.channel of
                        Just ( currentRss, _ ) ->
                            currentRss /= rssUrl

                        Nothing ->
                            True
            in
            if isStale then
                ( model, Cmd.none )

            else
                recordPlayback
                    ( { model | channel = Just ( rssUrl, Loadable (Just (Ok correctedFeed)) ), search = Nothing, episode = maybeEpisodeId }
                    , Cmd.none
                    )

        FeedFetched originalRss _ (Err err) ->
            case ( Url.fromString originalRss, model.channel ) of
                ( Just rssUrl, Just ( currentRss, _ ) ) ->
                    if rssUrl == currentRss then
                        ( { model | channel = Just ( currentRss, Loadable (Just (Err err)) ) }
                        , Cmd.none
                        )

                    else
                        ( model, Cmd.none )

                _ ->
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
                    , Cmd.batch
                        [ Nav.replaceUrl model.key ("/?q=" ++ Url.percentEncode query)
                        , Process.sleep 600 |> Task.perform (always (SearchDebounced query))
                        ]
                    )

                Nothing ->
                    ( model, Cmd.none )

        SearchDebounced query ->
            case model.search of
                Just searchState ->
                    if searchState.query == query && String.length query >= 2 then
                        ( { model | search = Just { searchState | results = Loadable Nothing } }
                        , searchCmd query
                        )

                    else
                        ( model, Cmd.none )

                Nothing ->
                    ( model, Cmd.none )

        SearchSubmitting ->
            case model.search of
                Just searchState ->
                    ( { model | search = Just { searchState | results = Loadable Nothing } }
                    , Cmd.batch
                        [ Nav.pushUrl model.key ("/?q=" ++ Url.percentEncode searchState.query)
                        , searchCmd searchState.query
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
                                |> List.sortBy .index
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
                    -- No feed loaded (e.g. from search results): subscribe immediately,
                    -- then fetch the feed so we can queue the 3 most recent episodes.
                    let
                        ( modelWithChannel, saveCmd ) =
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
                    in
                    ( modelWithChannel
                    , Cmd.batch
                        [ saveCmd
                        , Http.get
                            { url = "/proxy/rss/" ++ Url.percentEncode channelId
                            , expect = Http.expectString (Result.mapError httpErrorToString >> Result.andThen (X.run feedDecoder) >> InitialFeedFetched channelId channel)
                            }
                        ]
                    )

        InitialFeedFetched rss channel (Ok feed) ->
            let
                enrichedEpisodes =
                    Dict.map (\_ ep -> enrichEpisodeWith channel ep) feed.episodes

                recentEpisodes =
                    enrichedEpisodes
                        |> Dict.values
                        |> List.sortBy .index
                        |> List.take 3
                        |> List.map (\ep -> ( ep.id, ep ))
                        |> Dict.fromList
            in
            withLibrary
                (\lib ->
                    if Dict.member rss lib.channels then
                        { lib
                            | episodes = Dict.insert rss enrichedEpisodes lib.episodes
                            , queue = Dict.union recentEpisodes lib.queue
                        }

                    else
                        lib
                )
                model

        InitialFeedFetched _ _ (Err _) ->
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
            let
                snapshot =
                    case model.feedSnapshot of
                        Just eps ->
                            if List.any (\e -> e.id == episode.id) eps then
                                Just eps

                            else
                                Just (episode :: eps)

                        Nothing ->
                            Nothing
            in
            withLibrary
                (\lib -> { lib | queue = Dict.insert episode.id episode lib.queue })
                { model | feedSnapshot = snapshot }

        EpisodeWatched episodeId ->
            withLibrary
                (\lib -> { lib | watched = Set.insert episodeId lib.watched })
                model

        SearchUrlFetched query result ->
            case model.search of
                Just searchState ->
                    if searchState.query == query then
                        ( { model
                            | search =
                                Just
                                    { searchState
                                        | results =
                                            Loadable (Just (result |> Result.map (\feed -> [ feed.channel ])))
                                    }
                          }
                        , Cmd.none
                        )

                    else
                        ( model, Cmd.none )

                Nothing ->
                    ( model, Cmd.none )

        FeaturedFetched (Ok channels) ->
            case model.library of
                Loadable (Just (Ok lib)) ->
                    let
                        newLib =
                            { lib | featured = channels }
                    in
                    ( { model
                        | featured = Loadable (Just (Ok channels))
                        , library = Loadable (Just (Ok newLib))
                      }
                    , Cmd.batch
                        [ librarySaving (libraryEncoder newLib)
                        , Task.perform MaybeRefreshDiscover Time.now
                        ]
                    )

                _ ->
                    ( { model | featured = Loadable (Just (Ok channels)) }, Cmd.none )

        FeaturedFetched (Err err) ->
            ( { model | featured = Loadable (Just (Err (httpErrorToString err))) }, Cmd.none )

        DiscoverFeedFetched rss result ->
            case ( model.discoverPending, model.library ) of
                ( Just { pending, buffer }, Loadable (Just (Ok lib)) ) ->
                    let
                        newBuffer =
                            case result of
                                Ok feed ->
                                    buffer
                                        ++ (feed.episodes
                                                |> Dict.values
                                                |> List.sortBy .index
                                                |> List.filter (not << isLikelyShort)
                                                |> List.take 1
                                                |> List.map (\e -> { rss = rss, episode = enrichEpisodeWith feed.channel e })
                                           )

                                Err _ ->
                                    buffer

                        newPending =
                            Set.remove (Url.toString rss) pending
                    in
                    if Set.isEmpty newPending then
                        let
                            newDiscover =
                                if List.isEmpty newBuffer then
                                    lib.discover

                                else
                                    newBuffer |> List.take 30

                            newLib =
                                { lib | discover = newDiscover }
                        in
                        ( { model
                            | library = Loadable (Just (Ok newLib))
                            , discoverPending = Nothing
                          }
                        , librarySaving (libraryEncoder newLib)
                        )

                    else
                        ( { model | discoverPending = Just { pending = newPending, buffer = newBuffer } }
                        , Cmd.none
                        )

                _ ->
                    ( model, Cmd.none )

        MaybeRefreshDiscover now ->
            case ( model.library, model.featured ) of
                ( Loadable (Just (Ok lib)), Loadable (Just (Ok channels)) ) ->
                    let
                        nowMs =
                            Time.posixToMillis now

                        ttlMs =
                            10 * 60 * 1000

                        isStale =
                            case lib.discoverAt of
                                Nothing ->
                                    True

                                Just t ->
                                    nowMs - t > ttlMs
                    in
                    if not isStale || model.discoverPending /= Nothing then
                        ( model, Cmd.none )

                    else
                        let
                            shuffleScore s =
                                String.foldl (\ch acc -> modBy 1000003 (acc * 31 + Char.toCode ch)) nowMs s

                            targets =
                                channels
                                    |> List.filter (\c -> not (Dict.member (Url.toString c.rss) lib.channels))
                                    |> List.sortBy (\c -> shuffleScore (Url.toString c.rss))
                                    |> List.take 30

                            cmds =
                                targets
                                    |> List.map
                                        (\c ->
                                            Http.get
                                                { url = "/proxy/rss/" ++ Url.percentEncode (Url.toString c.rss)
                                                , expect = Http.expectString (Result.mapError httpErrorToString >> Result.andThen (X.run feedDecoder) >> DiscoverFeedFetched c.rss)
                                                }
                                        )

                            pendingUrls =
                                targets |> List.map (.rss >> Url.toString) |> Set.fromList

                            newLib =
                                { lib | discoverAt = Just nowMs }
                        in
                        if List.isEmpty cmds then
                            ( model, Cmd.none )

                        else
                            ( { model
                                | library = Loadable (Just (Ok newLib))
                                , discoverPending = Just { pending = pendingUrls, buffer = [] }
                              }
                            , Cmd.batch (librarySaving (libraryEncoder newLib) :: cmds)
                            )

                _ ->
                    ( model, Cmd.none )

        LinkClicked (Browser.Internal url) ->
            ( model
            , Nav.pushUrl model.key (Url.toString url)
            )

        LinkClicked (Browser.External url) ->
            ( model
            , Nav.load url
            )

        UrlChanged url ->
            let
                ( m, cmd ) =
                    route url { model | showHistory = False }
            in
            recordPlayback ( m, cmd )

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

        NoOp ->
            ( model, Cmd.none )

        ChannelRetrying rss ->
            case model.channel of
                Just ( rssUrl, _ ) ->
                    ( { model | channel = Just ( rssUrl, Loadable Nothing ) }
                    , Http.get
                        { url = "/proxy/rss/" ++ Url.percentEncode rss
                        , expect = Http.expectString (Result.mapError httpErrorToString >> Result.andThen (X.run feedDecoder) >> FeedFetched rss Nothing)
                        }
                    )

                Nothing ->
                    ( model, Cmd.none )

        PlayerFailed episodeId ->
            ( { model | playerError = Just episodeId }, Cmd.none )

        PlayerRetrying ->
            ( { model | playerError = Nothing }, Cmd.none )

        KeyPressed key ->
            case key of
                "j" ->
                    stepEpisode 1 model

                "k" ->
                    stepEpisode -1 model

                "/" ->
                    focusSearch model

                _ ->
                    ( model, Cmd.none )



-- ROUTING


routeQueryParser : Q.Parser { q : Maybe String, tag : Maybe String, e : Maybe String }
routeQueryParser =
    Q.map3 (\q tag e -> { q = q, tag = tag, e = e })
        (Q.string "q")
        (Q.string "tag")
        (Q.string "e")


route : Url -> Model -> ( Model, Cmd Msg )
route url modelIn =
    let
        parsedQuery =
            P.parse (P.top <?> routeQueryParser) { url | path = "/" }
                |> Maybe.withDefault { q = Nothing, tag = Nothing, e = Nothing }

        searchQuery =
            parsedQuery.q

        tagFilter =
            parsedQuery.tag

        episodeId =
            parsedQuery.e

        model =
            if modelIn.playerError /= Nothing && modelIn.episode /= episodeId then
                { modelIn | playerError = Nothing }

            else
                modelIn
    in
    case ( url.path, searchQuery, tagFilter ) of
        ( "/history", _, _ ) ->
            ( { model
                | search = Nothing
                , channel = Nothing
                , episode = episodeId
                , feedSnapshot = Nothing
                , showHistory = True
              }
            , Cmd.none
            )

        -- Saved channels: /?tag=saved
        ( "/", Nothing, Just "saved" ) ->
            ( { model
                | search = Just { query = "tag:saved", results = Loadable (Just (Ok (getLibrary model |> Maybe.map (.channels >> Dict.values) |> Maybe.withDefault []))) }
                , channel = Nothing
                , episode = episodeId
                , feedSnapshot = Nothing
              }
            , Cmd.none
            )

        -- Tag filter: /?tag={tag}
        ( "/", Nothing, Just tag ) ->
            ( { model
                | search = Just { query = "tag:" ++ tag, results = Loadable Nothing }
                , channel = Nothing
                , episode = episodeId
                , feedSnapshot = Nothing
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
                        , feedSnapshot = Nothing
                      }
                    , Cmd.none
                    )

                -- Entering search mode fresh
                Nothing ->
                    ( { model
                        | search = Just { query = query, results = Loadable (Just (Ok [])) }
                        , channel = Nothing
                        , episode = episodeId
                        , feedSnapshot = Nothing
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
            let
                snapshot =
                    case getLibrary model of
                        Just lib ->
                            lib.queue
                                |> Dict.values
                                |> List.filter (\ep -> not (Set.member ep.id lib.watched))
                                |> Just

                        Nothing ->
                            Nothing
            in
            ( { model
                | search = Nothing
                , channel = Nothing
                , episode = episodeId
                , feedSnapshot = snapshot
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
    { title = documentTitle model
    , body =
        [ div [ class "rows", id "body" ]
            [ header [ class "cols" ]
                [ div [ class "cols" ] <|
                    List.intersperse (span [] [ text "/" ]) <|
                        List.concat
                            [ [ a [ href "/" ] [ text "telecasts" ] ]
                            , model.search
                                |> Maybe.map
                                    (\{ query } ->
                                        let
                                            label =
                                                if String.isEmpty query then
                                                    "My Channels"

                                                else if query == "tag:saved" then
                                                    "My Channels"

                                                else if String.startsWith "tag:" query then
                                                    query
                                                        |> String.dropLeft 4
                                                        |> String.replace "-" " "
                                                        |> String.words
                                                        |> List.map
                                                            (\w ->
                                                                String.toUpper (String.left 1 w) ++ String.dropLeft 1 w
                                                            )
                                                        |> String.join " "

                                                else
                                                    "\"" ++ query ++ "\""
                                        in
                                        [ a [ href ("/?q=" ++ Url.percentEncode query), class "back" ] [ text label ] ]
                                    )
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
                            , if model.showHistory then
                                [ a [ href "/history" ] [ text "History" ] ]

                              else
                                []
                            , case ( model.search, model.channel, model.showHistory ) of
                                ( Nothing, Nothing, False ) ->
                                    [ a [ href "/" ] [ text "My Feed" ] ]

                                _ ->
                                    []
                            ]
                , div [ class "cols header-actions" ]
                    [ a [ href "/?tag=saved", class "header-action" ] [ text "MY CHANNELS" ]
                    , model.search
                        |> Maybe.map (\_ -> a [ href "?", class "header-action" ] [ text "✕" ])
                        |> Maybe.withDefault (a [ href "/?q=", class "header-action" ] [ text "SEARCH" ])
                    ]
                ]
            , case findSelectedEpisode model.episode model.channel model.library of
                Just ( episode, maybeChannel ) ->
                    div [ class "rows", id "player-section" ]
                        [ if model.playerError == Just episode.id then
                            viewPlayerError episode

                          else
                            let
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

                                onMediaError =
                                    Html.Events.on "error" (D.succeed (PlayerFailed episode.id))
                            in
                            if String.contains "youtube" srcStr then
                                iframe [ id "player", src srcStr, A.autoplay True ] []

                            else if isPeerTubeDownload && String.contains "/videos/embed/" peerTubeEmbedUrl then
                                iframe [ id "player", src peerTubeEmbedUrl, A.autoplay True, A.attribute "allowfullscreen" "true", A.attribute "sandbox" "allow-same-origin allow-scripts allow-popups allow-forms" ] []

                            else if String.endsWith ".mp3" srcStr || String.endsWith ".m4a" srcStr then
                                audio [ id "player", src srcStr, A.controls True, A.autoplay True, onMediaError ] []

                            else
                                video [ id "player", src srcStr, A.controls True, A.autoplay True, onMediaError ] []
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
            , if model.showHistory then
                viewHistory model

              else
                viewBody model
            , viewPlayerBar model
            ]
        ]
    }


viewBody : Model -> Html Msg
viewBody model =
    case ( model.search, model.channel ) of
        ( Just searchState, _ ) ->
            div [ class "rows", id "search" ]
                [ form [ class "cols", onSubmit SearchSubmitting ]
                    [ input
                        [ id "search-input"
                        , onInput SearchEditing
                        , value searchState.query
                        , A.placeholder "Search channels..."
                        ]
                        []
                    ]
                , div [ class "quick-tags" ]
                    (List.map viewTagLink discoverTags)
                , viewLoadable (Just SearchSubmitting)
                    (\channels ->
                        if List.isEmpty channels then
                            div [ class "empty-state" ]
                                [ text "No channels for "
                                , em [] [ text searchState.query ]
                                , text ". Try a broader term or a tag: filter."
                                ]

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
                                [ div [ class "channel-thumb-wrapper" ]
                                    [ viewThumbInner "channel-thumb" (channelThumbWithFallback feed.channel.thumb feed.episodes) ]
                                , div [ class "rows channel-header-info" ]
                                    [ h1 [] [ text feed.channel.title ]
                                    , div [ class "channel-header-meta" ]
                                        (List.filterMap identity
                                            [ feed.channel.author |> Maybe.map (\a -> span [] [ text a ])
                                            , channelEpisodeCount feed.channel.episodeCount feed.episodes
                                                |> Maybe.map (\c -> span [] [ text (String.fromInt c ++ " episodes") ])
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
                                        (List.map (\cat -> span [ class "tag tag--solid" ] [ text cat ]) cats)

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
                        [ viewError (Just (ChannelRetrying (Url.toString rss))) err ]
                )

        ( Nothing, Nothing ) ->
            div [ class "rows", id "my-feed" ]
                [ viewLoadable Nothing
                    (\lib ->
                        let
                            episodesToShow =
                                case model.feedSnapshot of
                                    Just snap ->
                                        let
                                            snapIds =
                                                snap |> List.map .id |> Set.fromList

                                            newQueueItems =
                                                if model.refreshing == Nothing then
                                                    lib.queue
                                                        |> Dict.values
                                                        |> List.filter (\ep -> not (Set.member ep.id snapIds) && not (Set.member ep.id lib.watched))

                                                else
                                                    []
                                        in
                                        newQueueItems ++ snap

                                    Nothing ->
                                        lib.queue |> Dict.values |> List.filter (\ep -> not (Set.member ep.id lib.watched))

                            shownIds =
                                episodesToShow |> List.map .id |> Set.fromList

                            subscribed =
                                lib.channels |> Dict.keys |> Set.fromList

                            fillEpisodes =
                                lib.discover
                                    |> List.filter
                                        (\d ->
                                            not (Set.member d.episode.id shownIds)
                                                && not (Set.member d.episode.id lib.watched)
                                                && not (Dict.member d.episode.id lib.queue)
                                                && not (Set.member (Url.toString d.rss) subscribed)
                                                && not (isLikelyShort d.episode)
                                        )
                                    |> List.take (max 0 (12 - List.length episodesToShow))

                            queueCards =
                                List.map (viewEpisodeCard (Just lib) Nothing) episodesToShow

                            fillCards =
                                List.map
                                    (\d ->
                                        div [ class "episode-card-dimmed" ]
                                            [ viewEpisodeCard (Just lib) (Just d.rss) d.episode ]
                                    )
                                    fillEpisodes
                        in
                        if List.isEmpty episodesToShow && List.isEmpty fillEpisodes then
                            if Dict.isEmpty lib.channels then
                                div [ class "empty-state" ]
                                    [ text "Subscribe to a channel to build your feed. Try "
                                    , a [ href "/?q=" ] [ text "search" ]
                                    , text "."
                                    ]

                            else
                                div [ class "empty-state" ] [ text "Finding episodes…" ]

                        else
                            div [ class "autogrid" ] (queueCards ++ fillCards)
                    )
                    model.library
                , viewDiscoverMore
                ]


viewDiscoverMore : Html Msg
viewDiscoverMore =
    div [ class "discover-more" ]
        [ h3 [ class "category-title" ] [ text "Keep browsing" ]
        , div [ class "quick-tags" ]
            (List.map viewTagLink discoverTags)
        ]


viewHistory : Model -> Html Msg
viewHistory model =
    div [ class "rows", id "history" ]
        [ viewLoadable Nothing
            (\lib ->
                if List.isEmpty lib.watchHistory then
                    div [ class "empty-state" ] [ text "Play an episode to start your history." ]

                else
                    div [ class "autogrid" ] (List.map (viewEpisodeCard (Just lib) Nothing) lib.watchHistory)
            )
            model.library
        ]


viewPlayerBar : Model -> Html Msg
viewPlayerBar model =
    case getLibrary model of
        Nothing ->
            text ""

        Just lib ->
            let
                currentId =
                    model.episode

                currentEpisode =
                    findSelectedEpisode model.episode model.channel model.library
                        |> Maybe.map Tuple.first

                upcomingQueue =
                    lib.queue
                        |> Dict.values
                        |> List.filter (\ep -> not (Set.member ep.id lib.watched) && Just ep.id /= currentId)
                        |> List.take 5

                featuredChannels =
                    case model.featured of
                        Loadable (Just (Ok channels)) ->
                            channels

                        _ ->
                            []

                subscribedRss =
                    lib.channels |> Dict.keys |> Set.fromList

                featuredUnseen =
                    featuredChannels
                        |> List.filter (\c -> not (Set.member (Url.toString c.rss) subscribedRss))

                currentThumb =
                    case currentEpisode of
                        Just ep ->
                            [ viewBarEpisode True ep ]

                        Nothing ->
                            []
            in
            div [ class "player-bar" ]
                (List.concat
                    [ currentThumb
                    , List.map (viewBarEpisode False) upcomingQueue
                    , List.map viewBarChannel featuredUnseen
                    ]
                )


viewBarEpisode : Bool -> Episode -> Html Msg
viewBarEpisode current ep =
    a
        [ href (episodeUrl Nothing ep.id)
        , class
            (if current then
                "bar-thumb current"

             else
                "bar-thumb"
            )
        , title ep.title
        ]
        [ viewThumbInner "bar-thumb-img" (episodeThumbnail ep) ]


viewBarChannel : Channel -> Html Msg
viewBarChannel c =
    a
        [ href ("/" ++ Url.percentEncode (Url.toString c.rss))
        , class "bar-thumb featured"
        , title c.title
        ]
        [ viewThumbInner "bar-thumb-img" c.thumb ]


findSelectedEpisode : Maybe Id -> Maybe ( Url, Loadable Feed ) -> Loadable Library -> Maybe ( Episode, Maybe Channel )
findSelectedEpisode maybeEpisode maybeChannel libraryL =
    case ( maybeEpisode, maybeChannel, libraryL ) of
        ( Just episodeId, Just ( _, Loadable (Just (Ok feed)) ), _ ) ->
            Dict.get episodeId feed.episodes
                |> Maybe.map (\ep -> ( ep, Just feed.channel ))

        ( Just episodeId, _, Loadable (Just (Ok lib)) ) ->
            case Dict.get episodeId lib.queue of
                Just ep ->
                    Just ( ep, Nothing )

                Nothing ->
                    Dict.foldl
                        (\rss eps acc ->
                            case acc of
                                Just _ ->
                                    acc

                                Nothing ->
                                    Dict.get episodeId eps
                                        |> Maybe.map (\ep -> ( ep, Dict.get rss lib.channels ))
                        )
                        Nothing
                        lib.episodes

        _ ->
            Nothing


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
            ]
        , div [ class "episode-info" ]
            [ a [ href (episodeUrl maybeRss episode.id), class "episode-title" ]
                [ text (episodePrefix ++ episode.title) ]
            , div [ class "episode-meta-row" ]
                [ case ( maybeRss, episode.channelTitle, episode.publishedAt ) of
                    ( Just _, _, Just date ) ->
                        div [ class "episode-meta" ] [ text date ]

                    ( Nothing, Just channelName, Just date ) ->
                        div [ class "episode-meta" ] [ text (channelName ++ " · " ++ date) ]

                    ( Nothing, Just channelName, Nothing ) ->
                        div [ class "episode-meta" ] [ text channelName ]

                    ( Nothing, Nothing, Just date ) ->
                        div [ class "episode-meta" ] [ text date ]

                    _ ->
                        div [ class "episode-meta" ] []
                , case maybeLib of
                    Just lib ->
                        if Set.member episode.id lib.watched then
                            text ""

                        else if Dict.member episode.id lib.queue then
                            button [ class "card-action active", onClick (EpisodeWatched episode.id), title "Mark as watched" ] [ text "✓" ]

                        else
                            button [ class "card-action", onClick (EpisodeQueued episode), title "Add to queue" ] [ text "＋" ]

                    Nothing ->
                        text ""
                ]
            ]
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
                , A.attribute "loading" "lazy"
                , A.attribute "decoding" "async"
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
                , A.attribute "loading" "lazy"
                , A.attribute "decoding" "async"
                , A.attribute "aria-hidden" "true"
                ]
                []
            , img
                [ class fgClass
                , src thumbUrl
                , A.attribute "loading" "lazy"
                , A.attribute "decoding" "async"
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

        libEpisodes =
            maybeLib
                |> Maybe.andThen (\lib -> Dict.get rss lib.episodes)
                |> Maybe.withDefault Dict.empty

        displayThumb =
            channelThumbWithFallback channel.thumb libEpisodes

        displayCount =
            case channel.episodeCount of
                Just _ ->
                    channel.episodeCount

                Nothing ->
                    let
                        n =
                            Dict.size libEpisodes
                    in
                    if n > 0 then
                        Just n

                    else
                        Nothing
    in
    div [ class "channel-card" ]
        [ a [ href ("/" ++ Url.percentEncode rss) ]
            [ div [ class "channel-thumb-wrapper" ]
                (viewChannelThumbLayered displayThumb)
            ]
        , div [ class "channel-info" ]
            [ div [ class "channel-title-row" ]
                [ case maybeLib of
                    Just lib ->
                        if Dict.member rss lib.channels then
                            button [ class "card-action active", onClick (ChannelUnsubscribing rss), title "Unsubscribe" ] [ text "✓" ]

                        else
                            button [ class "card-action", onClick (ChannelSubscribing rss channel), title "Subscribe" ] [ text "＋" ]

                    Nothing ->
                        button [ class "card-action", onClick (ChannelSubscribing rss channel), title "Subscribe" ] [ text "＋" ]
                , a [ href ("/" ++ Url.percentEncode rss), class "channel-title" ] [ text channel.title ]
                ]
            , case channel.author of
                Just author ->
                    if author == channel.title then
                        text ""

                    else
                        div [ class "channel-meta" ] [ text author ]

                Nothing ->
                    text ""
            , case displayCount of
                Just count ->
                    div [ class "channel-footer" ] [ text (String.fromInt count ++ " episodes") ]

                Nothing ->
                    text ""
            ]
        ]


channelEpisodeCount : Maybe Int -> Dict String Episode -> Maybe Int
channelEpisodeCount declared episodes =
    case declared of
        Just c ->
            Just c

        Nothing ->
            let
                n =
                    Dict.size episodes
            in
            if n > 0 then
                Just n

            else
                Nothing


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


documentTitle : Model -> String
documentTitle model =
    let
        playingPrefix =
            case findSelectedEpisode model.episode model.channel model.library of
                Just ( ep, _ ) ->
                    "▸ " ++ ep.title ++ " — "

                Nothing ->
                    ""

        context =
            if model.showHistory then
                "History"

            else
                case ( model.search, model.channel ) of
                    ( _, Just ( _, Loadable (Just (Ok feed)) ) ) ->
                        feed.channel.title

                    ( Just { query }, _ ) ->
                        if String.isEmpty query then
                            "Telecasts"

                        else if query == "tag:saved" then
                            "My Channels"

                        else if String.startsWith "tag:" query then
                            String.dropLeft 4 query

                        else
                            "Search: " ++ query

                    _ ->
                        "Telecasts"
    in
    playingPrefix ++ context


viewPlayerError : Episode -> Html Msg
viewPlayerError episode =
    div [ class "player-error" ]
        [ div [ class "player-error-msg" ] [ text "Couldn't play this file." ]
        , div [ class "player-error-actions" ]
            [ button [ class "error-retry", onClick PlayerRetrying ] [ text "retry" ]
            , a [ href (Url.toString episode.src), A.target "_blank", A.rel "noopener", class "player-error-link" ]
                [ text "open source" ]
            ]
        ]


viewLoadable : Maybe msg -> (a -> Html msg) -> Loadable a -> Html msg
viewLoadable retryMsg viewOk loadable =
    case loadable of
        Loadable Nothing ->
            div [ class "loading" ] []

        Loadable (Just (Err err)) ->
            viewError retryMsg err

        Loadable (Just (Ok a)) ->
            viewOk a


viewError : Maybe msg -> String -> Html msg
viewError retryMsg err =
    div [ class "error" ]
        (text err
            :: (case retryMsg of
                    Just msg ->
                        [ button [ class "error-retry", onClick msg ] [ text "retry" ] ]

                    Nothing ->
                        []
               )
        )


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


looksLikeUrl : String -> Bool
looksLikeUrl s =
    not (String.startsWith "tag:" s)
        && not (String.contains " " s)
        && (String.contains "://" s || String.startsWith "www." s)


searchCmd : String -> Cmd Msg
searchCmd query =
    if looksLikeUrl query then
        let
            normalized =
                normalizeFeedUrl query
        in
        Http.get
            { url = "/proxy/rss/" ++ Url.percentEncode normalized
            , expect =
                Http.expectString
                    (Result.mapError httpErrorToString
                        >> Result.andThen (X.run feedDecoder)
                        >> SearchUrlFetched query
                    )
            }

    else
        Http.get
            { url = "/search?q=" ++ Url.percentEncode query
            , expect = Http.expectJson ChannelsFetched (D.list channelDecoder)
            }


normalizeFeedUrl : String -> String
normalizeFeedUrl raw =
    let
        stripped =
            raw
                |> String.replace "http://" "https://"
                |> (\s ->
                        if String.startsWith "https://" s then
                            s

                        else
                            "https://" ++ s
                   )

        ytChannelMarker =
            "youtube.com/channel/"
    in
    case String.split ytChannelMarker stripped of
        [ _, rest ] ->
            let
                channelId =
                    rest |> String.split "/" |> List.head |> Maybe.withDefault "" |> String.split "?" |> List.head |> Maybe.withDefault ""
            in
            if String.isEmpty channelId then
                stripped

            else
                "https://www.youtube.com/feeds/videos.xml?channel_id=" ++ channelId

        _ ->
            stripped


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


recordPlayback : ( Model, Cmd Msg ) -> ( Model, Cmd Msg )
recordPlayback ( model, cmd ) =
    case ( model.episode, findSelectedEpisode model.episode model.channel model.library ) of
        ( Just epId, Just ( episode, _ ) ) ->
            case model.library of
                Loadable (Just (Ok lib)) ->
                    let
                        withoutDup =
                            List.filter (\e -> e.id /= epId) lib.watchHistory

                        newHistory =
                            (episode :: withoutDup) |> List.take 50

                        newLib =
                            { lib | watchHistory = newHistory, watched = Set.insert epId lib.watched }
                    in
                    if List.head lib.watchHistory |> Maybe.map .id |> (==) (Just epId) then
                        ( model, cmd )

                    else
                        ( { model | library = Loadable (Just (Ok newLib)) }
                        , Cmd.batch [ cmd, librarySaving (libraryEncoder newLib) ]
                        )

                _ ->
                    ( model, cmd )

        _ ->
            ( model, cmd )


withLibrary : (Library -> Library) -> Model -> ( Model, Cmd Msg )
withLibrary fn model =
    case model.library of
        Loadable (Just (Ok lib)) ->
            ( { model | library = Loadable (Just (Ok (fn lib))) }
            , librarySaving (libraryEncoder (fn lib))
            )

        _ ->
            ( model, Cmd.none )


navigableEpisodeIds : Maybe ( Url, Loadable Feed ) -> Maybe SearchState -> Loadable Library -> ( List Id, Maybe Url )
navigableEpisodeIds maybeChannel maybeSearch libraryL =
    case maybeChannel of
        Just ( rssUrl, Loadable (Just (Ok feed)) ) ->
            ( feed.episodes |> Dict.values |> List.sortBy .index |> List.map .id, Just rssUrl )

        Nothing ->
            case ( maybeSearch, libraryL ) of
                ( Nothing, Loadable (Just (Ok lib)) ) ->
                    ( lib.queue
                        |> Dict.values
                        |> List.filter (\ep -> not (Set.member ep.id lib.watched))
                        |> List.map .id
                    , Nothing
                    )

                _ ->
                    ( [], Nothing )

        _ ->
            ( [], Nothing )


stepEpisode : Int -> Model -> ( Model, Cmd Msg )
stepEpisode delta model =
    let
        ( ids, maybeRss ) =
            navigableEpisodeIds model.channel model.search model.library
    in
    if List.isEmpty ids || (delta < 0 && model.episode == Nothing) then
        ( model, Cmd.none )

    else
        let
            currentIdx =
                ids
                    |> List.indexedMap Tuple.pair
                    |> List.filter (\( _, id ) -> Just id == model.episode)
                    |> List.head
                    |> Maybe.map Tuple.first
                    |> Maybe.withDefault -1

            nextIdx =
                clamp 0 (List.length ids - 1) (currentIdx + delta)
        in
        case ids |> List.drop nextIdx |> List.head of
            Just id ->
                if Just id == model.episode then
                    ( model, Cmd.none )

                else
                    ( model, Nav.pushUrl model.key (episodeUrl maybeRss id) )

            Nothing ->
                ( model, Cmd.none )


focusSearch : Model -> ( Model, Cmd Msg )
focusSearch model =
    let
        focusCmd =
            Task.attempt (always NoOp)
                (Process.sleep 0
                    |> Task.andThen (\_ -> Browser.Dom.focus "search-input")
                )
    in
    case model.search of
        Nothing ->
            ( model, Cmd.batch [ Nav.pushUrl model.key "/?q=", focusCmd ] )

        Just _ ->
            ( model, focusCmd )



-- DECODERS


libraryDecoder : D.Decoder Library
libraryDecoder =
    D.succeed Library
        |> D.required "channels" (D.dict channelDecoder)
        |> D.required "episodes" (D.dict (D.dict episodeDecoder))
        |> D.optional "queue" (D.dict episodeDecoder) Dict.empty
        |> D.optional "watched" (D.list D.string |> D.map Set.fromList) Set.empty
        |> D.optional "watchHistory" (D.list episodeDecoder) []
        |> D.optional "featured" (D.list channelDecoder) []
        |> D.optional "discover" (D.list discoverEpisodeDecoder) []
        |> D.optional "discoverAt" (D.maybe D.int) Nothing


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


discoverEpisodeDecoder : D.Decoder DiscoverEpisode
discoverEpisodeDecoder =
    D.map2 DiscoverEpisode
        (D.field "rss" urlDecoder)
        (D.field "episode" episodeDecoder)


urlDecoder : D.Decoder Url
urlDecoder =
    D.string
        |> D.andThen
            (\s ->
                case Url.fromString s of
                    Just u ->
                        D.succeed u

                    Nothing ->
                        D.fail "Invalid URL"
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
        , ( "watchHistory", lib.watchHistory |> E.list episodeEncoder )
        , ( "featured", E.list channelEncoder lib.featured )
        , ( "discover", E.list discoverEpisodeEncoder lib.discover )
        , ( "discoverAt", encodeMaybe E.int lib.discoverAt )
        ]


discoverEpisodeEncoder : DiscoverEpisode -> E.Value
discoverEpisodeEncoder d =
    E.object
        [ ( "rss", E.string (Url.toString d.rss) )
        , ( "episode", episodeEncoder d.episode )
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
        parseInt s =
            String.toInt s |> Maybe.withDefault 0

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
                |> X.possiblePath [ "enclosure" ] (X.single (X.stringAttr "length" |> X.map parseInt))
                |> X.optionalPath [ "itunes:explicit" ] (X.single (X.string |> X.map isExplicitValue)) False

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


parseDuration : String -> Int
parseDuration str =
    case String.split ":" str |> List.filterMap String.toInt of
        [ h, m, s ] ->
            h * 3600 + m * 60 + s

        [ m, s ] ->
            m * 60 + s

        [ s ] ->
            s

        _ ->
            0


isExplicitValue : String -> Bool
isExplicitValue str =
    List.member (String.toLower str) [ "true", "yes", "1" ]


makeEpisodeDict : List Episode -> Dict Id Episode
makeEpisodeDict episodes =
    episodes
        |> List.indexedMap (\i ep -> ( ep.id, { ep | index = i } ))
        |> Dict.fromList
