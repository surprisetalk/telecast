module Tests exposing (..)

import Dict
import Expect
import Fuzz
import Json.Decode as D
import Json.Encode as E
import Main exposing (..)
import Set
import Test exposing (..)
import Time
import Url
import Xml.Decode as X



-- Helpers


exampleUrl : Url.Url
exampleUrl =
    case Url.fromString "https://example.com/feed.xml" of
        Just u ->
            u

        Nothing ->
            Debug.todo "exampleUrl: unreachable"


thumbUrl : Url.Url
thumbUrl =
    case Url.fromString "https://example.com/thumb.jpg" of
        Just u ->
            u

        Nothing ->
            Debug.todo "thumbUrl: unreachable"


sampleChannel : Main.Channel
sampleChannel =
    { title = "Sample Channel"
    , description = "A sample"
    , thumb = Just thumbUrl
    , rss = exampleUrl
    , updatedAt = "2024-01-01T00:00:00Z"
    , author = Just "Author"
    , episodeCount = Just 10
    , categories = Just [ "Tech" ]
    }


sampleEpisode : String -> Main.Episode
sampleEpisode id =
    { id = id
    , title = "Episode " ++ id
    , thumb = Just thumbUrl
    , coverArt = Nothing
    , src = exampleUrl
    , description = "desc " ++ id
    , index = 0
    , durationSeconds = Just 600
    , publishedAt = Just "2024-01-01T00:00:00Z"
    , season = Just 1
    , episodeNum = Just 1
    , channelTitle = Just "Sample Channel"
    , channelThumb = Just thumbUrl
    , isShort = False
    , viewCount = Nothing
    , fileSizeBytes = Nothing
    , isExplicit = False
    }


sampleLibrary : Main.Library
sampleLibrary =
    { channels = Dict.fromList [ ( "https://example.com/feed.xml", sampleChannel ) ]
    , episodes = Dict.fromList [ ( "https://example.com/feed.xml", Dict.fromList [ ( "ep1", sampleEpisode "ep1" ), ( "ep2", sampleEpisode "ep2" ) ] ) ]
    , queue = Dict.fromList [ ( "ep3", sampleEpisode "ep3" ) ]
    , watched = Set.fromList [ "ep-watched" ]
    , watchHistory = []
    }


emptyLibrary : Main.Library
emptyLibrary =
    { channels = Dict.empty
    , episodes = Dict.empty
    , queue = Dict.empty
    , watched = Set.empty
    , watchHistory = []
    }


sampleFeed : Main.Feed
sampleFeed =
    let
        ep1 =
            sampleEpisode "feed-ep-1"

        ep2 =
            sampleEpisode "feed-ep-2"
    in
    { channel = sampleChannel
    , episodes =
        Dict.fromList
            [ ( "feed-ep-1", { ep1 | index = 0 } )
            , ( "feed-ep-2", { ep2 | index = 1 } )
            ]
    }


loadedLib : Main.Loadable Main.Library
loadedLib =
    Main.Loadable (Just (Ok sampleLibrary))


loadedFeed : Main.Loadable Main.Feed
loadedFeed =
    Main.Loadable (Just (Ok sampleFeed))


unloaded : Main.Loadable a
unloaded =
    Main.Loadable Nothing



-- ============================================================
-- Library codecs
-- ============================================================


libraryCodecs : Test
libraryCodecs =
    describe "Library codecs"
        [ test "libraryEncoder → libraryDecoder round-trips sample library" <|
            \_ ->
                sampleLibrary
                    |> Main.libraryEncoder
                    |> D.decodeValue Main.libraryDecoder
                    |> Result.map libraryShape
                    |> Expect.equal (Ok (libraryShape sampleLibrary))
        , test "libraryDecoder accepts JSON missing optional 'queue' key" <|
            \_ ->
                E.object
                    [ ( "channels", E.dict identity Main.channelEncoder sampleLibrary.channels )
                    , ( "episodes", E.dict identity (E.dict identity Main.episodeEncoder) sampleLibrary.episodes )
                    , ( "watched", E.list E.string (Set.toList sampleLibrary.watched) )
                    ]
                    |> D.decodeValue Main.libraryDecoder
                    |> Result.map (.queue >> Dict.isEmpty)
                    |> Expect.equal (Ok True)
        , test "libraryDecoder ignores legacy 'history' and 'settings' keys" <|
            \_ ->
                E.object
                    [ ( "channels", E.object [] )
                    , ( "episodes", E.object [] )
                    , ( "queue", E.object [] )
                    , ( "watched", E.list E.string [] )
                    , ( "history", E.object [] )
                    , ( "settings", E.object [] )
                    ]
                    |> D.decodeValue Main.libraryDecoder
                    |> Result.map (.channels >> Dict.isEmpty)
                    |> Expect.equal (Ok True)
        , test "channelDecoder uses episode_thumb when thumb is null" <|
            \_ ->
                E.object
                    [ ( "title", E.string "X" )
                    , ( "description", E.string "d" )
                    , ( "thumb", E.null )
                    , ( "episode_thumb", E.string "https://ep.example.com/t.jpg" )
                    , ( "rss", E.string "https://ex.example.com/f.xml" )
                    , ( "updated_at", E.string "2024-01-01T00:00:00Z" )
                    ]
                    |> D.decodeValue Main.channelDecoder
                    |> Result.map (.thumb >> Maybe.map Url.toString)
                    |> Expect.equal (Ok (Just "https://ep.example.com/t.jpg"))
        , test "channelDecoder uses thumb when present (episode_thumb ignored)" <|
            \_ ->
                E.object
                    [ ( "title", E.string "X" )
                    , ( "description", E.string "d" )
                    , ( "thumb", E.string "https://primary.example.com/t.jpg" )
                    , ( "episode_thumb", E.string "https://fallback.example.com/t.jpg" )
                    , ( "rss", E.string "https://ex.example.com/f.xml" )
                    , ( "updated_at", E.string "2024-01-01T00:00:00Z" )
                    ]
                    |> D.decodeValue Main.channelDecoder
                    |> Result.map (.thumb >> Maybe.map Url.toString)
                    |> Expect.equal (Ok (Just "https://primary.example.com/t.jpg"))
        , test "channelDecoder falls back to null thumb when neither present" <|
            \_ ->
                E.object
                    [ ( "title", E.string "X" )
                    , ( "description", E.string "d" )
                    , ( "thumb", E.null )
                    , ( "rss", E.string "https://ex.example.com/f.xml" )
                    , ( "updated_at", E.string "2024-01-01T00:00:00Z" )
                    ]
                    |> D.decodeValue Main.channelDecoder
                    |> Result.map .thumb
                    |> Expect.equal (Ok Nothing)
        , test "urlDecoder accepts valid URL" <|
            \_ ->
                E.string "https://example.com/x"
                    |> D.decodeValue Main.urlDecoder
                    |> Result.map Url.toString
                    |> Expect.equal (Ok "https://example.com/x")
        , test "urlDecoder rejects garbage with 'Invalid URL' error" <|
            \_ ->
                case D.decodeValue Main.urlDecoder (E.string "not a url") of
                    Ok _ ->
                        Expect.fail "expected Err, got Ok"

                    Err err ->
                        D.errorToString err
                            |> String.contains "Invalid URL"
                            |> Expect.equal True
        ]


{-| Shape comparison that ignores Dict internal ordering by converting to lists.
-}
libraryShape : Main.Library -> List String
libraryShape lib =
    [ "channels:" ++ String.fromInt (Dict.size lib.channels)
    , "episodes:" ++ String.fromInt (Dict.size lib.episodes)
    , "queue:" ++ String.fromInt (Dict.size lib.queue)
    , "watched:" ++ String.fromInt (Set.size lib.watched)
    , "channel-titles:" ++ String.join "," (lib.channels |> Dict.values |> List.map .title)
    , "episode-ids:" ++ String.join "," (lib.episodes |> Dict.values |> List.concatMap Dict.keys |> List.sort)
    , "queue-ids:" ++ String.join "," (Dict.keys lib.queue)
    ]



-- ============================================================
-- Parse helpers
-- ============================================================


parseHelpers : Test
parseHelpers =
    describe "Pure parse helpers"
        [ test "parseDuration: HH:MM:SS" <|
            \_ -> Main.parseDuration "01:02:03" |> Expect.equal 3723
        , test "parseDuration: MM:SS" <|
            \_ -> Main.parseDuration "45:30" |> Expect.equal 2730
        , test "parseDuration: raw seconds" <|
            \_ -> Main.parseDuration "90" |> Expect.equal 90
        , test "parseDuration: garbage yields 0" <|
            \_ -> Main.parseDuration "garbage" |> Expect.equal 0
        , test "isExplicitValue: true/yes/1 are truthy" <|
            \_ ->
                [ "true", "yes", "1", "TRUE", "Yes" ]
                    |> List.map Main.isExplicitValue
                    |> Expect.equal [ True, True, True, True, True ]
        , test "isExplicitValue: false/no/0/other are falsy" <|
            \_ ->
                [ "false", "no", "0", "", "nope" ]
                    |> List.map Main.isExplicitValue
                    |> Expect.equal [ False, False, False, False, False ]
        , test "episodeUrl: with rss builds encoded URL" <|
            \_ ->
                Main.episodeUrl (Just exampleUrl) "ep1"
                    |> Expect.equal ("/" ++ Url.percentEncode (Url.toString exampleUrl) ++ "?e=ep1")
        , test "episodeUrl: without rss returns /?e=..." <|
            \_ ->
                Main.episodeUrl Nothing "ep/1"
                    |> Expect.equal ("/?e=" ++ Url.percentEncode "ep/1")
        , test "makeEpisodeDict: indexes episodes in order" <|
            \_ ->
                [ sampleEpisode "a", sampleEpisode "b", sampleEpisode "c" ]
                    |> Main.makeEpisodeDict
                    |> Dict.values
                    |> List.sortBy .index
                    |> List.map (\ep -> ( ep.id, ep.index ))
                    |> Expect.equal [ ( "a", 0 ), ( "b", 1 ), ( "c", 2 ) ]
        ]



-- ============================================================
-- Navigation helpers
-- ============================================================


navigation : Test
navigation =
    describe "Navigation helpers"
        [ test "navigableEpisodeIds: channel view returns feed episodes in index order" <|
            \_ ->
                Main.navigableEpisodeIds (Just ( exampleUrl, loadedFeed )) Nothing loadedLib
                    |> Expect.equal ( [ "feed-ep-1", "feed-ep-2" ], Just exampleUrl )
        , test "navigableEpisodeIds: my feed returns queue ids" <|
            \_ ->
                Main.navigableEpisodeIds Nothing Nothing loadedLib
                    |> Expect.equal ( [ "ep3" ], Nothing )
        , test "navigableEpisodeIds: search active returns empty" <|
            \_ ->
                Main.navigableEpisodeIds Nothing (Just { query = "x", results = Main.Loadable Nothing }) loadedLib
                    |> Expect.equal ( [], Nothing )
        , test "navigableEpisodeIds: empty library → []" <|
            \_ ->
                Main.navigableEpisodeIds Nothing Nothing (Main.Loadable (Just (Ok emptyLibrary)))
                    |> Expect.equal ( [], Nothing )
        , test "navigableEpisodeIds: unloaded library → []" <|
            \_ ->
                Main.navigableEpisodeIds Nothing Nothing unloaded
                    |> Expect.equal ( [], Nothing )
        , test "navigableEpisodeIds: watched items are filtered out of queue" <|
            \_ ->
                let
                    lib =
                        { sampleLibrary
                            | queue = Dict.fromList [ ( "ep3", sampleEpisode "ep3" ), ( "ep4", sampleEpisode "ep4" ) ]
                            , watched = Set.fromList [ "ep4" ]
                        }
                in
                Main.navigableEpisodeIds Nothing Nothing (Main.Loadable (Just (Ok lib)))
                    |> Tuple.first
                    |> Expect.equal [ "ep3" ]
        , test "findSelectedEpisode: returns queue episode when id matches" <|
            \_ ->
                Main.findSelectedEpisode (Just "ep3") Nothing loadedLib
                    |> Maybe.map (Tuple.first >> .id)
                    |> Expect.equal (Just "ep3")
        , test "findSelectedEpisode: falls back to channel episodes for subscribed episode" <|
            \_ ->
                Main.findSelectedEpisode (Just "ep1") Nothing loadedLib
                    |> Maybe.map (Tuple.first >> .id)
                    |> Expect.equal (Just "ep1")
        , test "findSelectedEpisode: unknown episode id → Nothing" <|
            \_ ->
                Main.findSelectedEpisode (Just "who-knows") Nothing loadedLib
                    |> Expect.equal Nothing
        , test "findSelectedEpisode: Nothing episode → Nothing" <|
            \_ ->
                Main.findSelectedEpisode Nothing Nothing loadedLib
                    |> Expect.equal Nothing
        , test "findSelectedEpisode: channel feed preferred over library lookup" <|
            \_ ->
                Main.findSelectedEpisode (Just "feed-ep-1") (Just ( exampleUrl, loadedFeed )) loadedLib
                    |> Maybe.map (Tuple.first >> .id)
                    |> Expect.equal (Just "feed-ep-1")
        ]



-- ============================================================
-- Feed XML decoders
-- ============================================================


podcastXml : String
podcastXml =
    """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>Test Podcast</title>
    <description>A sample podcast</description>
    <link>https://podcast.example.com</link>
    <lastBuildDate>Mon, 01 Jan 2024 12:00:00 GMT</lastBuildDate>
    <itunes:image href="https://podcast.example.com/cover.jpg" />
    <item>
      <guid>pod-ep-1</guid>
      <title>Pod Episode 1</title>
      <description>First episode</description>
      <pubDate>Mon, 01 Jan 2024 12:00:00 GMT</pubDate>
      <itunes:duration>01:02:03</itunes:duration>
      <itunes:season>1</itunes:season>
      <itunes:episode>1</itunes:episode>
      <itunes:explicit>no</itunes:explicit>
      <enclosure url="https://podcast.example.com/ep1.mp3" length="12345" type="audio/mpeg" />
    </item>
    <item>
      <guid>pod-ep-2</guid>
      <title>Pod Episode 2</title>
      <description>Second</description>
      <pubDate>Tue, 02 Jan 2024 12:00:00 GMT</pubDate>
      <itunes:duration>45:30</itunes:duration>
      <enclosure url="https://podcast.example.com/ep2.mp3" length="54321" type="audio/mpeg" />
    </item>
  </channel>
</rss>"""


youtubeXml : String
youtubeXml =
    """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
  <title>Test YouTube Channel</title>
  <description>desc</description>
  <author>
    <name>YT Author</name>
    <uri>https://www.youtube.com/channel/UCabc</uri>
  </author>
  <entry>
    <id>yt:video:vid1</id>
    <yt:videoId>vid1</yt:videoId>
    <title>YT Video 1</title>
    <published>2024-01-01T00:00:00Z</published>
    <link rel="alternate" href="https://www.youtube.com/watch?v=vid1" />
    <media:group>
      <media:description>First YT video</media:description>
      <media:thumbnail url="https://i.ytimg.com/vi/vid1/hqdefault.jpg" />
    </media:group>
  </entry>
  <entry>
    <id>yt:video:vid2</id>
    <yt:videoId>vid2</yt:videoId>
    <title>YT Video 2 (Shorts)</title>
    <published>2024-01-02T00:00:00Z</published>
    <link rel="alternate" href="https://www.youtube.com/shorts/vid2" />
    <media:group>
      <media:description>Short</media:description>
      <media:thumbnail url="https://i.ytimg.com/vi/vid2/hqdefault.jpg" />
    </media:group>
  </entry>
</feed>"""


standardRssXml : String
standardRssXml =
    """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Standard RSS</title>
    <description>A standard RSS feed</description>
    <link>https://rss.example.com</link>
    <image>
      <url>https://rss.example.com/logo.png</url>
    </image>
    <item>
      <guid>rss-1</guid>
      <title>Standard Item 1</title>
      <description>First</description>
      <link>https://rss.example.com/1</link>
      <pubDate>Mon, 01 Jan 2024 12:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>"""


feedDecoders : Test
feedDecoders =
    describe "Feed XML decoders"
        [ test "feedDecoder parses a podcast RSS feed" <|
            \_ ->
                X.run Main.feedDecoder podcastXml
                    |> Result.map (\f -> ( f.channel.title, Dict.size f.episodes ))
                    |> Expect.equal (Ok ( "Test Podcast", 2 ))
        , test "podcast feed: episode durations parsed" <|
            \_ ->
                X.run Main.feedDecoder podcastXml
                    |> Result.map (\f -> f.episodes |> Dict.values |> List.filterMap .durationSeconds |> List.sort)
                    |> Expect.equal (Ok [ 2730, 3723 ])
        , test "podcast feed: explicit=no decodes to False" <|
            \_ ->
                X.run Main.feedDecoder podcastXml
                    |> Result.map (\f -> f.episodes |> Dict.get "pod-ep-1" |> Maybe.map .isExplicit)
                    |> Expect.equal (Ok (Just False))
        , test "feedDecoder parses a YouTube channel feed" <|
            \_ ->
                X.run Main.feedDecoder youtubeXml
                    |> Result.map (\f -> ( f.channel.title, Dict.size f.episodes ))
                    |> Expect.equal (Ok ( "Test YouTube Channel", 2 ))
        , test "YouTube feed: /shorts/ link is flagged as isShort" <|
            \_ ->
                X.run Main.feedDecoder youtubeXml
                    |> Result.map
                        (\f ->
                            f.episodes
                                |> Dict.values
                                |> List.map (\ep -> ( ep.title, ep.isShort ))
                                |> List.sortBy Tuple.first
                        )
                    |> Expect.equal
                        (Ok
                            [ ( "YT Video 1", False )
                            , ( "YT Video 2 (Shorts)", True )
                            ]
                        )
        , test "feedDecoder parses a standard RSS feed" <|
            \_ ->
                X.run Main.feedDecoder standardRssXml
                    |> Result.map (\f -> ( f.channel.title, Dict.size f.episodes ))
                    |> Expect.equal (Ok ( "Standard RSS", 1 ))
        , test "feedDecoder returns Err on unknown XML root" <|
            \_ ->
                case X.run Main.feedDecoder "<?xml version=\"1.0\"?><unknown>nope</unknown>" of
                    Ok _ ->
                        Expect.fail "expected Err on unknown XML root"

                    Err _ ->
                        Expect.pass
        , test "feedDecoder returns Err on HTML input (adversarial)" <|
            \_ ->
                case X.run Main.feedDecoder "<!doctype html><html><body>not a feed</body></html>" of
                    Ok _ ->
                        Expect.fail "expected Err on HTML input"

                    Err _ ->
                        Expect.pass
        ]



-- ============================================================
-- Round-trip fuzz (small, focused)
-- ============================================================


codecFuzz : Test
codecFuzz =
    describe "Codec fuzz"
        [ fuzz (Fuzz.list (Fuzz.map sampleEpisode (Fuzz.intRange 0 50 |> Fuzz.map String.fromInt))) "episode list round-trips through JSON" <|
            \episodes ->
                let
                    lib =
                        { emptyLibrary
                            | episodes =
                                Dict.fromList
                                    [ ( "https://ex.example.com/f.xml", episodes |> List.map (\ep -> ( ep.id, ep )) |> Dict.fromList )
                                    ]
                        }
                in
                lib
                    |> Main.libraryEncoder
                    |> D.decodeValue Main.libraryDecoder
                    |> Result.map libraryShape
                    |> Expect.equal (Ok (libraryShape lib))
        ]
