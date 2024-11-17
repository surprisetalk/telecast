module Rss exposing (Feed, decodeFeed)

import Xml.Decode as Decode exposing (Decoder, Error)


type alias Feed =
    { title : String
    , thumbnail : String
    , channelUrl : String
    , episodes : List Episode
    }


type alias Episode =
    { title : String
    , thumbnail : String
    , src : String
    , description : String
    }


decodeFeed : String -> Result String Feed
decodeFeed =
    Decode.run feedDecoder


feedDecoder : Decoder Feed
feedDecoder =
    Decode.oneOf
        [ youtubeFormatDecoder -- Try YouTube format first
        , standardRssDecoder -- Fall back to standard RSS
        ]



-- YouTube Atom Feed Format


youtubeFormatDecoder : Decoder Feed
youtubeFormatDecoder =
    Decode.map4 Feed
        (Decode.path [ "title" ]
            (Decode.single Decode.string)
        )
        (Decode.succeed "yt.png")
        (Decode.path [ "author", "uri" ]
            (Decode.single Decode.string)
        )
        entriesDecoder


entriesDecoder : Decoder (List Episode)
entriesDecoder =
    Decode.path [ "entry" ]
        (Decode.list entryDecoder)


entryDecoder : Decoder Episode
entryDecoder =
    Decode.map4 Episode
        (Decode.path [ "title" ] (Decode.single Decode.string))
        (Decode.path [ "media:group", "media:thumbnail" ]
            (Decode.single (Decode.stringAttr "url"))
            |> Decode.withDefault "yt.png"
        )
        (Decode.path [ "yt:videoId" ]
            (Decode.single Decode.string)
            |> Decode.map (\videoId -> "https://www.youtube.com/embed/" ++ videoId)
        )
        (Decode.path [ "media:group", "media:description" ]
            (Decode.single Decode.string)
            |> Decode.withDefault ""
        )



-- Standard RSS 2.0 Format


standardRssDecoder : Decoder Feed
standardRssDecoder =
    Decode.map4 Feed
        -- Channel title
        (Decode.path [ "rss", "channel", "title" ]
            (Decode.single Decode.string)
        )
        -- Channel image
        (Decode.oneOf
            [ Decode.path [ "rss", "channel", "image", "url" ]
                (Decode.single Decode.string)
            , Decode.succeed "default-thumbnail.jpg"
            ]
        )
        -- Channel link
        (Decode.path [ "rss", "channel", "link" ]
            (Decode.single Decode.string)
        )
        -- Items/episodes
        (Decode.path [ "rss", "channel" ]
            (Decode.single itemsDecoder)
        )


itemsDecoder : Decoder (List Episode)
itemsDecoder =
    Decode.path [ "item" ]
        (Decode.list itemDecoder)


itemDecoder : Decoder Episode
itemDecoder =
    Decode.map4 Episode
        (Decode.path [ "title" ]
            (Decode.single Decode.string)
        )
        (Decode.oneOf
            [ Decode.path [ "itunes:image" ]
                (Decode.single (Decode.stringAttr "href"))
            , Decode.path [ "image", "url" ]
                (Decode.single Decode.string)
            , Decode.succeed "default-thumbnail.jpg"
            ]
        )
        (Decode.oneOf
            [ Decode.path [ "enclosure" ]
                (Decode.single (Decode.stringAttr "url"))
            , Decode.path [ "media:content" ]
                (Decode.single (Decode.stringAttr "url"))
            , Decode.path [ "link" ]
                (Decode.single Decode.string)
            ]
        )
        (Decode.oneOf
            [ Decode.path [ "description" ]
                (Decode.single Decode.string)
            , Decode.path [ "itunes:summary" ]
                (Decode.single Decode.string)
            , Decode.succeed ""
            ]
        )
