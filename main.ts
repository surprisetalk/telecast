import { HTTPException } from "jsr:@hono/hono/http-exception";
import { Hono, Context } from "jsr:@hono/hono";
import { some, every, except } from "jsr:@hono/hono/combine";
import { createMiddleware } from "jsr:@hono/hono/factory";
import { logger } from "jsr:@hono/hono/logger";
import { prettyJSON } from "jsr:@hono/hono/pretty-json";
import { basicAuth } from "jsr:@hono/hono/basic-auth";
import { html } from "jsr:@hono/hono/html";
import { cors } from "jsr:@hono/hono/cors";
import {
  getSignedCookie,
  setSignedCookie,
  deleteCookie,
} from "jsr:@hono/hono/cookie";
import { serveStatic } from "jsr:@hono/hono/deno";

const PI_KEY = "TWTGLQDR8H7LKHYUURNT";
const PI_SECRET = "QKVK$k2TSSae9vRyCHqV9sKj^$tUP2bpHekd2CKf";

const app = new Hono();

app.use("/*", cors());

async function fetchPodcasts(query: string) {
  try {
    const time = Math.floor(Date.now() / 1000);
    const hash = await crypto.subtle
      .digest("SHA-1", new TextEncoder().encode(PI_KEY + PI_SECRET + time))
      .then((buf) =>
        Array.from(new Uint8Array(buf))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join(""),
      );

    const response = await fetch(
      // https://api.podcastindex.org/api/1.0/podcasts/bymedium?medium=video
      `https://api.podcastindex.org/api/1.0/search/byterm?q=video%20${encodeURIComponent(query)}`,
      {
        headers: {
          "X-Auth-Date": time.toString(),
          "X-Auth-Key": PI_KEY,
          Authorization: hash,
          "User-Agent": "Telecast/1.0",
        },
      },
    );

    const data = await response.json();

    return data.feeds.map((feed: any) => ({
      title: feed.title,
      thumbnail: feed.artwork,
      rss: feed.url,
    }));
  } catch (error) {
    console.error("Error fetching podcasts:", error);
    return [];
  }
}

app.get("/proxy/rss", async (c) => {
  const url = c.req.query("url");
  if (!url) return c.json({ error: "URL parameter is required" }, 400);
  const response = await fetch(url);
  const text = await response.text();
  return new Response(text, {
    headers: {
      "Content-Type": "application/xml",
      "Access-Control-Allow-Origin": "*",
    },
  });
});

app.get("/channels", async (c) => {
  const query = c.req.query("q")?.toLowerCase() || "";
  return c.json([
    ...youtubeChannels.filter((channel) =>
      channel.title.toLowerCase().includes(query),
    ).map(x => ({
      title: x.title,
      thumbnail: "/yt.png", // TODO
      rss: `https://www.youtube.com/feeds/videos.xml?channel_id=${x.id}`
    })),
    ...(await fetchPodcasts(query)),
  ]);
});

// app.get("/*", async (c) => {
//   try {
//     const path = c.req.path === "/" ? "/index.html" : c.req.path;
//     const file = await Deno.readFile(`./public${path}`);
//     const extension = path.split(".").pop();
//
//     const mimeTypes: Record<string, string> = {
//       html: "text/html",
//       css: "text/css",
//       js: "application/javascript",
//     };
//
//     return new Response(file, {
//       headers: {
//         "Content-Type":
//           mimeTypes[extension || ""] || "application/octet-stream",
//       },
//     });
//   } catch {
//     return c.notFound();
//   }
// });

app.use("/*", serveStatic({ root: "./public" }));

// Deno.serve(
//   {
//     hostname: Deno.env.get("HOST") ?? "0.0.0.0",
//     port: parseInt(Deno.env.get("PORT") ?? "") || 8080,
//   },
//   app.fetch,
// );

export default app;

const youtubeChannels = `
UC-2EEGGKW0UFQN1sfz3Q34A;;GoGo Penguin Music
UC-2YHgc363EdcusLIBbgxzg;;Joe Scott
UC-91UA-Xy2Cvb98deRXuggA;;Joshua Fluke
UC-ItiI-CI-ZoASr885LebJQ;;Life Art
UC-LsL7haDdBQ9zvH_3LHIrw;;Jade Rose
UC-Qj80avWItNRjkZ41rzHyw;;Soph's Notes
UC-QvtVCaLPmiSMNNEZYVIYQ;;Trope Anatomy
UC-WICcSW1k3HsScuXxDrp0w;;Curry On!
UC-akozxNLMPcMcs0qVvS1VQ;;ICTP Mathematics
UC-l69It3hxAY3tkBH_utLNQ;;Life Uncontained
UC-nDNn0pKEyOGH5d0_ttqSA;;pinguefy
UC-rd5G_2jWSV-sAi-xpdFZA;;Tiny-Giant LifeStyle
UC-to_wlckb-bFDtQfUZL3Kw;;Door Monster
UC-tsNNJ3yIW98MtPH6PWFAQ;;iDubbbzTV2
UC0-5wjMW1Gx3ej5V4uNoXRQ;;Hoshina Com Channel
UC06E4Y_-ybJgBUMtXx8uNNw;;TheBackyardScientist
UC07v1rZ4g6vxjoHRAoJZWHg;;Open Space
UC09TnEfWiPZptifvgYxwC4Q;;Rosianna Halse Rojas
UC0GnZ40gZON2-sIuGR0Pxhw;;SPIETV
UC0JB7TSe49lg56u6qH8y_MQ;;GDC
UC0M0rxSz3IF0CsSour1iWmw;;Cinemassacre
UC0QGD7ROEWwk6UxvNtye3vw;;Elon Musk best videos
UC0XNssyypOLiq4vVgXm9NtQ;;Life in Jars?
UC0YvoAYGgdOfySQSLcxtu1w;;Beau of the Fifth Column
UC0aanx5rpr7D1M7KCFYzrLQ;;Shoe0nHead
UC0eOlAEMdVgpmThPkpmR-qQ;;Valefisk
UC0intLFzLaudFG-xAvUEO-A;;Not Just Bikes
UC0k238zFx-Z8xFH0sxCrPJg;;Architectural Digest
UC0l2QTnO1P2iph-86HHilMQ;;ElixirConf
UC0pEknZxL7Q1j0Ok8qImWdQ;;Compose Conference
UC18YhnNvyrU2kTwCyj9p5ag;;KingK
UC1D3yD4wlPMico0dss264XA;;NileBlue
UC1DTYW241WD64ah5BFWn4JA;;Sam O'Nella Academy
UC1Fz5YWpwDUV66YLURRQp3w;;Let's do it.
UC1V-DYqsaj764uBis9-UDug;;Foureyes Furniture
UC1_uAIS3r8Vu6JjXWvastJg;;Mathologer
UC1owqZBjR5nMfYqJJRatRSw;;pennsays
UC1wdxEm1PouNsPcAdO6zQcQ;;LabX
UC2-AhNgFrlFIdohyRwIaUIQ;;BRANDMADE.TV
UC2C_jShtL725hvbm1arSV9w;;CGP Grey
UC2DjFE7Xf11URZqWBigcVOQ;;EEVblog
UC2PA-AKmVpU6NKCGtZq_rKQ;;Philosophy Tube
UC2RThr58y6eXFHF_ZLyIFEA;;Paladin Amber
UC2TXq_t06Hjdr2g_KdKpHQg;;media.ccc.de
UC2UXDak6o7rBm23k3Vv5dww;;Tina Huang
UC2bkHVIDjXS7sgrgjFtzOXQ;;engineerguy
UC2kxl-dcUYQQvTCuQtfuChQ;;!!Con
UC2umy62ojMfxzzHkVcgEUUA;;Karen Puzzles
UC2wNnyb3vWhOt0K6LpBrtGg;;Mental Checkpoint
UC2xHMABk_sX2aC14-D7OhIw;;Premodernist
UC2zb5cQbLabj3U9l3tke1pg;;smalin
UC33WWpCRHft51iEV2hVcRzQ;;The Urban Doctor
UC36svRAhmVj4pBqqSc6NkJA;;ViolinistBAKA
UC38wy8I4pO6xVDZiWxxeeng;;MegaIceTV
UC395nJwyQzy9QqNonJ50PLQ;;Scott Murphy
UC3BGlwmI-Vk6PWyMt15dKGw;;O'Reilly
UC3CBOpT2-NRvoc2ecFMDCsA;;Crime Pays But Botany Doesn't
UC3D2AvQ1WyZwufYcVz_DwTw;;DeadwingDork
UC3ETCazlHenpXEsrEJH-k5A;;The Anime Man
UC3HjOlfXBQJO12-YhumbJCg;;Aztrosist
UC3LqW4ijMoENQ2Wv17ZrFJA;;PBS Idea Channel
UC3XTzVzaHQEd30rQbuvCtTQ;;LastWeekTonight
UC3azLjQuz9s5qk76KEXaTvA;;suckerpinch
UC3bQlN3L10pHmVLeC5tXRGw;;dukope1
UC3j3w-oUtIAm_KI857ydvUA;;Thoisoi2 - Chemical Experiments!
UC3mY2SKYhPjqImtBBXsR6_Q;;MayTree
UC3ogrx6d9oohf6D42G44j1A;;Terrible Writing Advice
UC3qbvcgOHXRIFIofXyd1vBw;;Mic The Snare
UC3tdeGrp7CmSy__Mc_ttvYw;;Found Footage Fest
UC4EQHfzIbkL_Skit_iKt1aA;;Moist Charlie Clips
UC4QZ_LsYcvcq7qOsOhpAX4A;;ColdFusion
UC4Sh3cP9IAyDfsrFju0eRdg;;Gio San Pedro
UC4USoIAL9qcsx5nCZV_QRnA;;iDubbbzTV
UC4YaOt1yT-ZeyB0OmxHgolA;;A.I.Channel
UC4ihNhN8iN9QPg2XTxiiPJw;;Inside the Score
UC4lWmzWWYixVOD-7oK6tguw;;Lauren Reilly
UC4m2G6T18_JcjwxwtwKJijw;;samy kamkar
UC4mvIQntW-fX27Ez-U-KDHw;;Luke Correia
UC4rqhyiTs7XyuODcECvuiiQ;;Scott The Woz
UC4zyoIAzmdsgpDZQfO1-lSA;;Cyberpunk 2077
UC513PdAP2-jWkJunTh5kXRw;;CrunchLabs
UC52kszkc08-acFOuogFl5jw;;Tibees
UC55S8D_44ge2cV10aQmxNVQ;;European Lisp Symposium
UC5Dw9TFdbPJoTDMSiJdIQTA;;Whatifalthist
UC5I2hjZYiW9gZPVkvzM8_Cw;;Techmoan
UC5Lz88Rt3GT75YT2ORAmaMQ;;Cornell Lab of Ornithology
UC5Pnrxqqg4BLTsfsUzWw5Pw;;HVACR VIDEOS
UC5UYMeKfZbFYnLHzoTJB1xA;;Schaffrillas Productions
UC5WaJC2b4I0-jgRMZFHZqyw;;Avdi Grimm
UC5fdssPqmmGhkhsJi4VcckA;;Innuendo Studios
UC5syIuMiCsVyfSpFD-DtjEA;;seasteading
UC5xuqNwz7qX1AgXzHG6tvKg;;Chavis von Bradford
UC5y_hpfH1ChKcKx7wUEM2cg;;WUZU clay
UC6-ymYjG0SU0jUWnWh9ZzEQ;;Wisecrack
UC6107grRI4m0o2-emgoDnAA;;SmarterEveryDay
UC66lPJ8u2N1i2Bh_TMaWagg;;Contraption Collection
UC6BLQ4Po0euDOZq9gUgkWAQ;;Forrest Valkai
UC6By2dBlmhqcuSMPf3K7TMg;;JENNI.SWISS
UC6DWQXHnjvxhfRqhAGCb1yA;;i make xyz
UC6Je0KLSDuKLfKs1lEBzKrQ;;Mike Diva
UC6MFZAOHXlKK1FI7V0XQVeA;;ProZD
UC6Om9kAkl32dWlDSNlDS9Iw;;DEFCONConference
UC6ZIKcLUAdxTUOB9yIo3baw;;Sadworld
UC6a8lp6vaCMhUVXPyynhjUA;;Ruby Granger
UC6dsQSn70Cem7zFsUANHqpQ;;kenny lauderdale
UC6mIxFTvXkWQVEHPsEdflzQ;;GreatScott!
UC6n8I1UDTKP1IWjQMg6_TwA;;The B1M
UC6nSFpj9HTCZ5t-N3Rm3-HA;;Vsauce
UC6pdMJwtkbCNoQRwbaNt77A;;HomeMadeModern
UC6x7GwJxuoABSosgVXDYtTw;;I Like To Make Stuff
UC7-E5xhZBZdW-8d7V80mzfg;;Jenny Nicholson
UC7590VTWe6m0kq3gJcgLINg;;The Taylor Series
UC7EBjRBYU7I8hfKguxKAi7A;;Godly Oddity
UC7FkqjV8SU5I8FCHXQSQe9Q;;ISHITANI FURNITURE
UC7GV-3hrA9kDKrren0QMKMg;;CinemaTyler
UC7IcJI8PUf5Z3zKxnZvTBog;;The School of Life
UC7XFmdssWgaPzGyGbKk8GaQ;;Web DM
UC7_-v3Z79dzOKnq0CrczQEw;;Synthesizer Keith
UC7_gcs09iThXybpVgjHZ_7g;;PBS Space Time
UC7c8mE90qCtu11z47U0KErg;;nature video
UC7dEjIUwSxSNcW4PqNRQW8w;;Systematic Program Design
UC7dF9qfBMXrSlaaFFDvV_Yg;;Gigguk
UC7k7WPHxxBZM145BX_SKDwQ;;The Minute Hour
UC7o-UFkoAPCoKxpKOfrs4zQ;;UsefulCharts
UC7pp40MU_6rLK5pvJYG3d0Q;;Hila Klein
UC7uoovBt-854ZO4-4tosU5g;;kutiman
UC7wT_mqUvCHEIWm1cuw_T1Q;;Bluewhisper
UC7z7QwsK120X7hs7Wqi05aA;;Sky Williams
UC89lIdGnKlEozb1WcYQprNw;;Dyalog Usermeeting
UC8EQAfueDGNeqb1ALm0LjHA;;Exploring Alternatives
UC8JE00xTMBOqKs7o0grFTfQ;;Poppy
UC8JOgFXp-I3YV6dsKqqQdUw;;Caroline Winkler
UC8P_raHQ4EoWTSH2GMESMQA;;Game Score Fanfare
UC8R8FRt1KcPiR-rtAflXmeg;;Nahre Sol
UC8Ujq8PBm0MWraaXd8MsIAQ;;b304
UC8e0Sg8TmRRFJytjEGhmVTg;;Rhystic Studies
UC8juAMAjKpaft2TIa8Hu08A;;TheRussianGenius
UC8uT9cgJorJPWu7ITLGo9Ww;;The 8-Bit Guy
UC9-y-6csu5WGm29I7JiwpnA;;Computerphile
UC9EJcp4ppeqKET1f_Z0S8Tw;;Fashion Elitist
UC9PBzalIcEQCsiIkq36PyUA;;Digital Foundry
UC9RM-iSvTu1uPJb8X5yp3EQ;;Wendover Productions
UC9UvlOBknCU5OLRHLCHTnmQ;;BowserVids
UC9aRTgvFLqnK1S0RsWZzlMw;;Modustrial Maker
UC9iFhgHa0mgyowznnlakO8Q;;Ms Pantsu
UC9mFio7rXEgtRQAhoIeGAew;;Syros
UC9pO2YNforRbdwKOh09djKA;;Blank on Blank
UC9y-hip1xFU5VFFcTKkGv2A;;whales have teeth
UCAAAQDyYsbuJbixvl1Z0k0w;;yeule
UCAG1ABZP-c7wuNt0fziHtsA;;Caroline Konstnar
UCAHPCNxU4A-TUV-lnu7u4tA;;adrisaurus
UCAK4C6aa-BXlqD2KsTx54xw;;Precious Plastic
UCAL3JXZSzSm8AlZyD3nQdBA;;Primitive Technology
UCAMTSVcvh86hOXREOiHnJcQ;;Lawn Care Juggernaut
UCAPfHpUZv4AnnFTyOzX0_TQ;;KAMUI BRAND
UCASjdyu0y8XQ9qJnqxsKHnQ;;Tucker Gott
UCAajKTeS-mCS3PccJUrrIzw;;Bryan Ropar's Plastic Chair World 
UCAfaLxhKe_77oolMLutK26w;;thatistheplan
UCAgoEUwn-LQy0fTyUxMngag;;FrankJavCee
UCApwcZw_xawOTzQFoYVOJmw;;24 Frames Of Nick
UCB31oh4SvSvz5LCM84Pov9w;;jasonofthel33t
UCBBIgxO-8jgVZpsj6uk4aVA;;Bryan Cantrill
UCBLvUpsQXGZKAdVeg41WxKg;;nimspr
UCBODyKF0JMbUd6D9Bklyzbw;;Alpharad
UCBQ3TEq5SrUuTJuMl1S_4ig;;Tokyo Llama
UCBTFh3fPtiOoXSfTWz0cbPg;;墨韵 Moyun Official
UCBa659QWEk1AI4Tg--mrJ2A;;Tom Scott
UCBbnbBWJtwsf0jLGUwX5Q3g;;Journey to the Microcosmos
UCBePKUYNhoMcjBi-BRmjarQ;;Natsumi Moe - VTuber ( New Channel @ Raven Manor)
UCBkuiMC1rIybuTcyMK-jWKw;;RCSBProteinDataBank
UCBs2Y3i14e1NWQxOGliatmg;;Mother's Basement
UCBsuOBu-dxj5bx1KMgmar5g;;TheHappieCat
UCC26K7LTSrJK0BPAUyyvtQg;;Brandon James Greer
UCC5UEz9jQPg8z3WjgHHVEHw;;Terry Davis Old Archive
UCCDA5Yte0itW_Bf6UHpbHug;;Postgres Open
UCCHcEUksSVKsRDH86j77Ntg;;thelonelyisland
UCCKpicnIwBP3VPxBAZWDeNA;;Money & Macro
UCCODtTcd5M1JavPCOr_Uydg;;Extra History
UCCOIcdii1bQmfSPHeNNw4Qw;;Rob Chapman
UCCU0HzTA9ddqOgtuV-TJ9yw;;Dry Creek Wrangler School
UCCeR7BtDUauD9jlVT67epTg;;DoctorBenjy FM
UCCghUBYXUjmJWBO5GlWcxCw;;nocaps
UCCnL9i3G8vnbQ6mR1DBqvRA;;Anisa
UCCoxJKMgcTOpDKUFRnA9OnA;;Kelly Inspiration
UCCrnCItH17W-64FDzjwOi5w;;The Science Elf
UCCuoqzrsHlwv1YyPKLuMDUQ;;Jonathan Blow
UCCwC_kDHfa5h7kF71tl19TQ;;Global Drug Survey
UCD0y51PJfvkZNe3y3FR5riw;;Chyrosran22
UCD4IBgj-11jK_uWWaixINgg;;The Rpg Monger
UCDAXXrX2uUwvy7NXpPJWAAg;;Mike Rugnetta
UCDAjO0-hd_RS8ZYJ4W-Iq5Q;;Savannah Brown
UCDGfxKKI5jew1CrrBrEUMhw;;ClownC0re
UCDJULR1Gih0yctzWBMS7EYg;;benjiplant
UCDKiHSPstsj0silp519gt6w;;Hack Music Theory
UCDRbNGFusqlXX4a5vwi9ouQ;;Vat19
UCDT-KKAV1iTIoD1j7AZKkYw;;Leo Vader
UCDUPGR6uL5uz0_hiRAQjZMQ;;Vlogs Of Knowledge
UCDWIvJwLJsE4LG1Atne2blQ;;h3h3Productions
UCDYlcvoMPGSO4djU2Lb2O6Q;;Teardown
UCDcdv91SdfM0GnVqfBtl8CA;;Yet Another Urbanist
UCDetdM5XDZD1xrQHDPgEg5w;;Dictionary of Obscure Sorrows
UCDez53TT1_v3jr3lGv-QhKw;;Mirror Conf
UCDkKoP4JFr0zr_KGzYYvK1A;;Nahneen Kula
UCDnLCQmz9ZX2vz3NVptvfyQ;;Tofupupper
UCDrekHmOnkptxq3gUU0IyfA;;Devon Crawford
UCDsO-0Yo5zpJk575nKXgMVA;;RocketJump
UCDt05G3v2e6ptGvIwERnY_w;;Trolligarch
UCDyWzuw_u0TBnRaoAcVg0jw;;NonStampCollector
UCE-ISfQt6yEem0kG5X7M-yg;;Tabletop Terrors
UCE9ix6JTrCJwMrs9wsLUMJg;;Spasmodius
UCEBb1b_L6zDS3xTUrIALZOw;;MIT OpenCourseWare
UCEBcDOjv-bhAmLavY71RMHA;;Lambda World
UCEHXNknwbsRu73QsakWIdzQ;;The8BitDrummer
UCEIwxahdLz7bap-VDs9h35A;;Steve Mould
UCEKJKJ3FO-9SFv5x5BzyxhQ;;2kliksphilip
UCEOXxzW2vU0P-0THehuIIeg;;Captain Disillusion
UCEQg9lX9Y61J4U9Gck9QsWg;;Atrioc VODs
UCETeXD_3awsQv-9rSdCYXQQ;;GET HANDS DIRTY
UCEeL4jELzooI7cyrouQzoJg;;Little Joel
UCEjBDKfrqQI4TgzT9YLNT8g;;Ghost Town Living
UCErSSa3CaP_GJxmFpdjG9Jw;;Lessons from the Screenplay
UCEtB-nx5ngoNJWEzYa-yXBg;;FilmJoy
UCEtohQeDqMSebi2yvLMUItg;;LambdaConf
UCExygIrhaBggJ5DXtqP_fnQ;;Spincoaster
UCF1fG3gT44nGTPU2sVLoFWg;;Patrick (H) Willems
UCF2kPqOyRz2A1FHcUgFJHfQ;;Knob Feel
UCFCEuCsyWP0YkP3CZ3Mr01Q;;The Plain Bagel
UCFEE2GWkn6QyBJvjSvY9nhQ;;Mat stiddard
UCFIA7jtCUAyQmdGV_5_wg-A;;Pinball Expert
UCFItIX8SIs4zqhJCHpbeV1A;;Censored Gaming
UCFJ9VmME1Y2Cj3MCnv2kjeQ;;Ashot
UCFL15pr0h8iZYNB22jHu0zQ;;Stoccafisso design
UCFQMO-YL87u-6Rt8hIVsRjA;;Hello Future Me
UCFbRdRGijPR4oBjQ0fVCSmw;;björk
UCFdazs-6CNzSVv1J0a-qy4A;;donoteat01
UCFhXFikryT4aFcLkLw2LBLA;;NileRed
UCFk__1iexL3T5gvGcMpeHNA;;Looking Glass Universe
UCFsDMlkYLpTVt9-cqmZxqZg;;Will Neff
UCFtc3XdXgLFwhlDajMGK69w;;NightHawkInLight
UCFyAgi9phA7ErVY_bPC1Cjg;;T&H - Inspiration & Motivation
UCG-KntY7aVnIGXYEBQvmBAQ;;Thomas Frank
UCG1h-Wqjtwz7uUANw6gazRw;;Lindsay Ellis
UCGIxoEZMpO2u5rguh4WGfBA;;Oliver Dowie
UCGJykI0BRfFV044deqERlxQ;;OskarPuzzle
UCGLKal__JOIrgv6ME8HVFag;;evilzebra!
UCGSGPehp0RWfca-kENgBJ9Q;;jREG
UCGaVdbSav8xWuFWTadK6loA;;vlogbrothers
UCGc8ZVCsrR3dAuhvUbkbToQ;;City Beautiful
UCGclf1lbRVsjePym5R9Ge5Q;;Nicki Baber
UCGeABNLJrrNXhAVHnmIYVqQ;;Th3Vale
UCGiJeCKTVKIxtaYZOidh19g;;Dunk Tank
UCGjQDPRA9zvdjEsSrdYUHVA;;Al Murray
UCGm3CO6LPcN-Y7HIuyE0Rew;;Monty Python
UCGwu0nbY2wSkW8N-cghnLpA;;Jaiden Animations
UCGzXtNdhjPxvCNWFme1bG0g;;SerpaDesign
UCHC4G4X-OR5WkY-IquRGa3Q;;Tom Scott plus
UCHZZFExyVSWR1gAj0nwye6g;;Miruku
UCH_VqR5rFFhgjZmM31xA3Ag;;Accented Cinema
UCH_ZSZa9uaTvttzAWe-Srbg;;GoatJesus
UCHhnf3RgHabfk5f2gUX6EVQ;;Ygg Studio
UCHiwtz2tCEfS17N9A-WoSSw;;Pop Culture Detective
UCHnyfMqiRRG1u-2MsSQLbXA;;Veritasium
UCHsRtomD4twRf5WVHHk-cMw;;TierZoo
UCI1XS_GkLGDOgf8YLaaXNRA;;CalebCity
UCI3XOx7AS4fKGmu4zCaWgFA;;Radio Heartland
UCI5qWAMf5PHLNcM13R8pfiQ;;Dolan Darker
UCI9DUIgtRGHNH_HmSTcfUbA;;The Closer Look
UCIGRhqYssT6IGPYOnZBFYKw;;Mattias Pilhede
UCIKptA3Cmt4Fen5TaNJtmRw;;LocalScriptMan
UCIZa-t5ctYtAn6BruNTxxwQ;;This Glorious Clockwork
UCIabPXjvT5BVTxRDPCBBOOQ;;Dani
UCIcGc8tDHYZ3vY3NcS8JXaQ;;b2studios
UCIc_DkRxo9UgUSTvWVNCmpA;;Demuxed
UCIgKGGJkt1MrNmhq3vRibYA;;NurdRage
UCIhJnsJ0IHlVNnYfp-gw_5Q;;Cal Newport
UCIjUIjWig0r5DIixQrt6A3A;;t3ssel8r
UCIoNgwHpavUi2UnC68cKgbw;;Marshall McGee
UCIu2Fj4x_VMn2dgSB1bFyQA;;Dylan Tallchief
UCJ-vHE5CrGaL_ITEg-n3OeA;;TheraminTrees
UCJ0-OtVpF0wOKEqT2Z1HEtA;;ElectroBOOM
UCJ0zCC_pb_p5rH2PqWlzBEw;;Key of Geebz
UCJ4Dx798nFsEdsBv5m4_eOA;;DualEx
UCJ6KZTTnkE-s2XFJJmoTAkw;;Accursed Farms
UCJ6o36XL0CpYb6U5dNBiXHQ;;Shaun
UCJ6q9Ie29ajGqKApbLqfBOg;;Black Hat
UCJA-dDMFs59cslPrZdeQFYw;;The Gaze
UCJJNuq_MQOq46x0vSnkvNWg;;Sonny and Cher Reticulated Pythons
UCJJvEXCTt1x1adr8hsf3P-g;;Bastl Instruments
UCJOh5FKisc0hUlEeWFBlD-w;;jan Misali
UCJOiqToQ7kiakqTLE7Hdd5g;;Early Music Sources
UCJPZCp-OxhkpYeG6YMHghMQ;;Science Marshall
UCJSLcxugFPqeovTsGu4Ozrw;;Sorcerer Tal
UCJTsi9IYU1baF_Znrfd1Jxg;;RetroTech Journal
UCJWdIshy58RFXq9kpm_wCLg;;Cutshort
UCJYJgj7rzsn0vdR7fkgjuIA;;styropyro
UCJkMlOu7faDgqh4PfzbpLdg;;Nerdwriter1
UCJquYOG5EL82sKTfH9aMA9Q;;Rick Beato
UCJsfRTW3Xi0H_8lcGRAKjyA;;JVNA
UCK-LGcQznM5spT0nxzLqLjQ;;MCKook
UCK3kaNXbB57CLcyhtccV_yw;;Jerma985
UCKDGP3EheRKgrbFg7EQkeaw;;The Sea Rabbit
UCKEt1xKVBLuL175dkk8rqLg;;Mouthy Buddha
UCKQFFUBLNh0bCLY21ST8MWQ;;maxmoefoetwo
UCKUGFkMQq-79xYLVSsgXeFQ;;lol ik
UCKUm503onGg3NatpBtTWHkQ;;Skip Intro
UCKZknGw0Nfc2dOQIaRDjYAQ;;Nolan Pilgrim
UCKagup3Qlq9jXOw6OCNK1RQ;;CCNeverender
UCKimIvyUjBQIZlu7KIhBuAA;;Nick Winter
UCKirXBZV7hE4Fws3VSdYkRQ;;Robin Greenfield
UCKrD_GYN3iDpG_uMmADPzJQ;;Erlang Solutions
UCKwM-7sO1_Tw9EmYhKfpBBw;;Perkins Builder Brothers
UCKzJFdi57J53Vr_BkTfN3uQ;;Primer
UCL-KWzX_hw7yfVR7WPQxIeA;;Neuroposter
UCL3IRp9f41q4hu15T3oPFqg;;ItsRadishTime
UCL3XrA4SheRl6y0NsRhGjRA;;maxmoefoegames
UCLB7AzTwc6VFZrBsO2ucBMg;;Robert Miles AI Safety 
UCLLJDyZ7kmJ8sgbuuc3oazg;;Core Ideas
UCLPA0Dhi1VXQDGbkXwjDUzQ;;X Pilot
UCLPbE15DGzP0bFNz5F03Wmg;;The Cartoon Cipher
UCLXo7UDZvByw2ixzpQCufnA;;Vox
UCL_f53ZEJxp8TtlOkHwMV9Q;;Jordan B Peterson
UCLhUvJ_wO9hOvv_yYENu4fQ;;Siro Channel
UCLqCmbd6bgcLaBVz3aA-68A;;P丸様。
UCLqkQ-UBSie7KARWZezRS6g;;fallaway6554
UCLt4d8cACHzrVvAz9gtaARA;;Neuralink
UCLt9kIslIa1ffiM8A04KORw;;W&M Levsha
UCLtDjLXW28vTumLCEBA37IQ;;Mirron
UCLx053rWZxCiYWsBETgdKrQ;;LGR
UCMLwTDp037k4ClptkxPElpg;;CelloBassett
UCMMe19DcsqMHzNqeTltR5hw;;Jartopia
UCMOBdfLjLT-PzrGzld8GjRw;;Carbon
UCMOqf8ab-42UUQIdVoKwjlQ;;Practical Engineering
UCMV8p6Lb-bd6UZtTc_QD4zA;;Baggers
UCMVCs1F_XGueuaD9AfgTWmg;;Big Thing Podcast Clips and Livestreams
UCMX1A8WPVQtOTZmanT8YseA;;Useless Game Dev
UCMYtONm441rBogWK_xPH9HA;;Mirai Akari Project
UCMb0O2CdPBNi-QqPk5T3gsQ;;James Hoffmann
UCMlGfpWw-RUdWX_JbLCukXg;;CppCon
UCMm211NGh4Ls5SAMZJF7E8A;;pannenkoek2012
UCMmA0XxraDP7ZVbv4eY3Omg;;DSLR Video Shooter
UCMpizQXRt817D0qpBQZ2TlA;;singingbanana
UCN2tXJuw6k7fNcuA_b785LQ;;itemLabel
UCN5CBM1NkqDYAHgS-AbgGHA;;Oh The Urbanity!
UCNEo-pwzdXhjv5RC_TzaeRQ;;Adam Lee
UCNMZr1ag6hvc-ePzNZYuIlA;;REACTION VIDEOS
UCNcpKG4D0_nxBYwtgD4iA7w;;Lightbath
UCNhX3WQEkraW3VHPyup8jkQ;;Langfocus
UCNvsIonJdJ5E4EXMa65VYpA;;ContraPoints
UCO1cgjhGzsSYb1rsB4bFe4Q;;Fun Fun Function
UCOGeU-1Fig3rrDjhm9Zs_wg;;Vihart
UCOHxDwCcOzBaLkeTazanwcw;;Game of Trades
UCOK2ZYAhxDXELwAHMcKwD2g;;Brittany Balyn
UCOSE9z-emcWgU8pSKmoV59g;;SethComedy
UCOWcZ6Wicl-1N34H0zZe38w;;Level1Linux
UCOXmyB6hxo7CNMSh5oJ5nBA;;TheChemistryShack
UCOfSatGfGMCVHViBCd4_rOA;;Julie Khuu
UCOuWeOkMrq84u5LY6apWQ8Q;;TREY the Explainer
UCOuddH5GyBXp-_tv_ASdp_A;;Nick Robinson
UCP3Ge131YXD3IqGU-NOO1kw;;Fraser Valley Rose Farm
UCP5bYRGZUJMG93AVoMekz9g;;Imaginary Ambition
UCP5tjEmvPItGyLhmjdwP7Ww;;RealLifeLore
UCPFnHiJx1P9UY05_F9sOu1g;;C0nc0rdance
UCPI1x2iyASeNaeRYVSGXTqA;;Mattias Holmgren
UCPOq4e1UIq-ARfEbQrr8PzQ;;eevnxx
UCPZUQqtVDmcjm4NY5FkzqLA;;Rousseau
UCPdp_RAwS93XCBeAnSTLq7g;;BINKBEATS
UCPeP2SrulRVc08mE-gJC4gg;;LinksterGames
UCPnSaAAVVo0q1tfWY5S3j7g;;withwendy
UCQ-W1KE9EYfdxhL6S4twUNw;;The Cherno
UCQASKpYeiD7Eh_mfhaTrS0Q;;Luna Lee
UCQEUvBxemTOMYSEVaTNumRw;;Jamie Loftus
UCQFLh2QSvEQSoGoSTX0lXDQ;;Oliver Knill
UCQHX6ViZmPsWiYSFAyS0a3Q;;GothamChess
UCQNDbo3DnvKFTekjCoeLNqA;;"Escape To The Dream, Restoring The Château."
UCQUPI1PxfE4-bqwuI26I2HA;;BocoupLLC
UCQYADFw7xEJ9oZSM5ZbqyBw;;Kaguya Luna Official
UCQj4ZJd2QxRHwVYQbMvcKdQ;;itmeJP
UCQmEp9ivvkh2jmEID8qtJ_g;;Dan Snyder
UCQrVyDNc8d5Fc2TT4kYGB3Q;;Optalysys
UCR1D15p_vdP3HkrH8wgjQRw;;Internet Historian
UCR1IuLEqb6UEA_zQ81kwXfg;;Real Engineering
UCR4s1DE9J4DHzZYXMltSMAg;;HowToBasic
UCR8c07H7gBWEbtNl4A0j8Lw;;Jaquan the Jequel
UCRAAaJtFsvdRSaZ4hf0k8AA;;Ply Collection
UCRDDHLvQb8HjE2r7_ZuNtWA;;Signals Music Studio
UCRDWbupIgwPM2pD4EgSiEDA;;Summoning Alt
UCREa2DYQx7m9vHFIpbmt2-w;;PippenFTS
UCRIZtPl9nb9RiXc9btSTQNw;;Food Wishes
UCRd9JHiQvqwT8O4d0QGI9jQ;;Scam Nation
UCRkxqq-GNo-mE5BIR43byxA;;My Japanese Animes
UCRlICXvO4XR4HMeEB9JjDlA;;Thoughty2
UCRs41MXZpAhXgiD4KjTjabg;;Xefox Music
UCRvqjQPSeaWn-uEx-w0XOIg;;Benjamin Cowen
UCRxAgfYexGLlu1WHGIMUDqw;;JunsKitchen
UCRxcunGDFb8Em4-TGoCVg7g;;KroboProductions
UCS0N5baNlQWJCUrhCEo8WlA;;Ben Eater
UCS4FAVeYW_IaZqAbqhlvxlA;;Context Free
UCSC1HqVmTaE4Shn32ihbC7w;;Bobby Duke Arts
UCSCRVmBT1YyuAlCA8c9FJRA;;The Nomadic Movement
UCSI9gHatsjD_pjDJMxvzQrg;;Camille Bigeault
UCSPLhwvj0gBufjDRzSQb3GQ;;BobbyBroccoli
UCSRxOAnl6WVjz4NeH44lA0Q;;The Original Ace
UCSb-xYOELhIqVr2n9s-b_4w;;Linus Boman
UCSbyncU597LMwb3HhnAI_4w;;Epic Gardening
UCSdma21fnJzgmPodhC9SJ3g;;NakeyJakey
UCSju5G2aFaWMqn-_0YBtq5A;;Stand-up Maths
UCSkzHxIcfoEr69MWBdo0ppg;;Jonas Čeika - CCK Philosophy
UCT31um1Ic8KweVWEMBC1K7A;;TooDamnFilthy
UCT5HLUjjXdqUSUnpblFNOwQ;;Elm Europe
UCTGHqw41qk_WyK3wJK7nweg;;Brickcrafts
UCTSRIY3GLFYIpkR2QwyeklA;;Drew Gooden
UCTUtqcDkzw7bisadh6AOx5w;;12tone
UCTWcrFkcu1RtWlj0EXfNN-A;;Nicro
UCTYqtrFYU-goX-4IkbKjHkg;;SpleinaGawd
UCTb6Oy0TXI03iEUdRMR9dnw;;Stuff You Should Know
UCTd7KzdwnFE3lm6LCfYDmUQ;;Seek Discomfort
UCTeYrzSQ3YCp3RovGH4y8Ew;;Strong Towns
UCTjqo_3046IXFFGZ_M5jedA;;jackisanerd
UCTkprzdjIT66PP78XRSpOVA;;DemetriMartinComedy
UCTz8K5TMmkQkRArybXfoVDg;;Investment Joy
UCU1_l0ZJyTK_7HZZ3Ruw8Dg;;MAPS
UCU457BSCp41Yz0QuTn8Sm2g;;Miumiu Guitargirl
UCUAKaXyq2hVBCph1LOUtuqg;;집밥요리 Home Cooking
UCUERVRulpmC0DMspYCXlqaw;;Trevor Wong
UCUH5uajsvjan8wE6GWOrRJg;;Sariel's Bricks & Pets
UCUHW94eEFW7hkUMVaZz4eDg;;minutephysics
UCUQo7nzH1sXVpzL92VesANw;;DIY Perks
UCUR1pFG_3XoZn3JNKjulqZg;;thoughtbot
UCUW49KGPezggFi0PGyDvcvg;;Zack Freedman
UCUcpdKYl1DkbrtLx4LmcHrA;;jazzijazzful
UCUfB51wmNKIz5vI4vzobe5A;;moemoemoe
UCUkRj4qoT1bsWpE_C8lZYoQ;;ThinMatrix
UCUlvYyW7UVtNJQ1KTv_Bsdg;;Nozomi Entertainment
UCUmLRMERmJrmUtgnbFfknAg;;Randy
UCUpkp-6fXuG9dqfoJ99XTmw;;Puffin Forest
UCUyDOdBWhC1MCxEjC46d-zw;;Alex Hormozi
UCUzQJ3JBuQ9w-po4TXRJHiA;;jdh
UCV5vCi3jPJdURZwAOO_FNfQ;;The Thought Emporium
UCV8i0RAQ3kAxs8xWmB-lK-Q;;The Dutch Farmer
UCVJgocEWT3u49_4GtulGHnQ;;Off Grid w/ Jake & Nicolle
UCVLsq0_WCBBhhCDKX6Gaz4w;;Derek Sivers
UCVOpX2P5wygh7sB1KXgh_5g;;Kobeomsuk furniture
UCVdlcqbM4oh0xJIQAxiaV5Q;;100 gecs
UCVhfFXNY0z3-mbrTh1OYRXA;;iDubbbzgames
UCW8D2ZkRhW-imCrHWB79fqg;;Tim Sexton - Pinball Developer
UCWF0PiUvUi3Jma2oFgaiX2w;;VICE TV
UCWIfRAZiiYeyN6pukhNBeQQ;;Geeks Wood Shop
UCWTFGPpNQ0Ms6afXhaWDiRw;;Now You See It
UCWUVUbJ_HNO91JgDxcLS2Kw;;Donny Greens
UCWcDx9NvKanW9i-oHb0Kz6g;;Storymakers
UCWhiokx685TXHK9F4vdFoAw;;Albino
UCWjmAUHmajb1-eo5WKk_22A;;Audiotree
UCWnPjmqvljcafA0z2U1fwKQ;;Confreaks
UCWq-qJSudqKrzquTVep9Jwg;;The Royal Ocean Film Society
UCWqr2tH3dPshNhPjV5h1xRw;;Super Bunnyhop
UCWx0Upf4IqFfgUZzS-e03Tw;;MushFarmer
UCX7Mvnv00tQ79-jyJQClsiA;;Recycle Rebuild
UCXL749sGwKyaPOuelps5L7g;;OfficialBlueBen
UCXN7NMwjjQpBHxzMwOPYzjQ;;PES
UCXi_-ZgBkZ4_zOFG9aqNu0A;;Reactor
UCXyVz9-w9Ippr-j2Yz4zAcQ;;Savage Books
UCY1kMZp36IQSyNx_9h4mpCg;;Mark Rober
UCY3A_5R_m3PXCn5XDhvBBsg;;Adam Millard - The Architect of Games
UCY5VgGzF-FvnUXIQOtUhuPw;;The Offcut
UCY7p_KVoBpn6YEiVUnvF_lQ;;Pegbarians
UCYAm24PkejQR2xMgJgn7xwg;;Stewart Hicks
UCYF21hRSNHImllXr6wW_nHQ;;AlexEnterprises
UCYFvEPbFbDIVRiODrh1-x4g;;MowtenDoo
UCYKZ6tv8d2rkGCMU_ja-b1Q;;WHAT THE FUNGUS
UCYO_jab_esuFRV4b17AJtAw;;3Blue1Brown
UCYeEDbIjLyHF-TBUM1u9jCQ;;creikey
UCYr2H4WxB8LtXDExK79ZLEA;;Elnoe Budiman
UCYtu3JxrpI1XjNn-B_HqW4Q;;My Little Thought Tree
UCYxBY8mhJ7R2rMIcQ28H_Zw;;Ujico*/Snail's House
UCZ-GmmYFkLbxvpyDR7fU__Q;;scrumpy
UCZ03CytzVCaij-HXhFdMHeg;;Manime Matt
UCZFipeZtQM5CKUjx6grh54g;;Isaac Arthur
UCZH3Sv_10mGvCDIYICPjb1Q;;The World of Interiors
UCZJVzJk_24aefzpKAbqiP9Q;;Pikasprey Blue
UCZKyj7wDE51SMbkrRBT6SdA;;Nerrel
UCZYTClx2T1of7BRZ86-8fow;;SciShow
UCZdGJgHbmqQcVZaJCkqDRwg;;The Q
UCZn_h4YsrFy1ZjHGK7Z5NKw;;Uniquenameosaurus
UC_0A6J2IXGDhy00jaY1uy6A;;Crease Origami
UC_3BTjvtaAsCwfwjQDSqFTQ;;Andy Ward's Ancient Pottery
UC_QIfHvN9auy2CoOdSfMWDw;;Strange Loop Conference
UC_X2BzWhnbpLN0hkeMtxXUw;;AnimeEveryday
UC_aRwjPdVkLxaklApX7Ga3w;;Life Eternal
UC_c1gdsojLxBGkgzS0NsvUw;;Maddox
UC_oQ6vAc_Mku_G5li4eUjAA;;The Home Inspector
UC_q-UNDJeEBSHqKzAP_8x_A;;EricTheCarGuy
UC_x5XG1OV2P6uZZ5FSM9Ttw;;Google for Developers
UC_zztIHGbBz9L-ZM-Ta2O1Q;;YUA/藤崎由愛
UCa35qyNpnlZ_u8n9qoAZbMQ;;HowStuffWorks
UCa9uWLHFMrwka4azMRNSefA;;Alan Watts - Topic
UCaDVcGDMkvcRb4qGARkWlyg;;Participant
UCaEKhXcW7dY65JoQB6fGhxg;;KNOWER MUSIC
UCaIG6vStP7xh313mPzJClbA;;chillcomputerguy
UCaN8DZdc8EHo5y1LsQWMiig;;Big Joel
UCaTznQhurW5AaiYPbhEA-KA;;Molly Rocket
UCabaQPYxxKepWUsEVQMT4Kw;;Healthcare Triage
UCafEZMU5s8geb9oIly6xTrg;;Robin Waldun
UCafxR2HWJRmMfSdyZXvZMTw;;LOOK MUM NO COMPUTER
UCaifrB5IrvGNPJmPeVOcqBA;;Kruggsmash
UCaitDvTHajRG-RzCLcHnmeQ;;MathProofsable
UCakAg8hC_RFJm4RI3DlD7SA;;brian david gilbert
UCarhVHQDU63divhaYPScVnQ;;Overanalyzing Avatar
UCarxZ8bKjfFzUOgN5LjYOhQ;;Knobs
UCb1Ti1WKPauPpXkYKVHNpsw;;LBC
UCbMtJOly6TpO5MQQnNwkCHg;;Wood By Wright ASMR
UCbSVRvbYKLQ0zTodfkwz0sg;;BluShades
UCbWcXB0PoqOsAvAdfzWMf0w;;Fredrik Knudsen
UCbfYPyITQ-7l4upoX8nvctg;;Two Minute Papers
UCboMX_UNgaPBsUOIgasn3-Q;;Funhaus
UCbphDfwSJmxk1Ny_3Oicrng;;Storytellers
UCbqd2YmFeHMwxlj4NcN5zPQ;;Zimri Mayfield
UCbxQcz9k0NRRuy0ukgQTDQQ;;AustinMcConnell
UCc3EpWncNq5QL0QhwUNQb7w;;Paul Sellers
UCcAvljdM2NMdMYq_pvT9pBw;;DouchebagChocolat
UCcScIr2iskFm-zRo8FZ7cRw;;BREADSWORD
UCcTt3O4_IW5gnA0c58eXshg;;8-Bit Keys
UCcXhhVwCT6_WqjkEniejRJQ;;Wintergatan
UCcdbBVSvHFELrUkRYSNbcug;;Uncivilized Elk
UCcddcRNcQfVwCMmvV2QWf8Q;;Films&Stuff
UCcefcZRL2oaA_uBNeo5UOWg;;Y Combinator
UCciKHCG06rnq31toLTfAiyw;;linux.conf.au
UCcnyjTK4IheQN2ycsE7NZTQ;;BeatTheBush
UCcoO-8J0EYQHGPFQqwmAzVQ;;exurb2a
UCcpWQjpQJ465FYJEx2DuDFA;;suburban homestead
UCcsZIp1nU1AZsALHwyWZCgQ;;iDubbbzStream
UCcxo5COqhVc84JYS_bRdLyg;;New York Vocal Coaching
UCd-qVRcjoK9zjtDs_LRxSmw;;FUNKe
UCd3Uy1Seh49HyeI3p-XFgkQ;;Channel 5 Clips
UCd6Za0CXVldhY8fK8eYoIuw;;Freedom in Thought
UCdC0An4ZPNr_YiFiYoVbwaw;;Daily Dose Of Internet
UCdIM_XmhsVYbBhl3pgPq3dA;;Robuilt
UCdM-fLpO0Nv67NLDofSl9yA;;슛뚜sueddu
UCdWeaG-8WPWpd6qcuz_-abw;;PC Music
UCdcemy56JtVTrsFIOoqvV8g;;ANDREW HUANG
UCdgUN8rX3SEb9L7FDub3I6A;;Design Theory
UCdkkQvJoB0kGgYHCYwSkdww;;Louie Zong
UCdlyCox9tf9rElYfT4puA_Q;;Stephen Travers Art
UCdnJJ2_mzqHwKIX_SmCVHTA;;Antiques Roadshow PBS
UCduKuJToxWPizJ7I2E6n1kA;;BroScienceLife
UCdwshbwxNBoCCBoZGgf3U6Q;;The Third Build
UCdxTCCRnQgfi2vr2fZupYIQ;;Carl Bugeja
UCe-5wDW9r3-C0HVdcm9_knA;;Kalle Flodin
UCeKXXs1A7EC60_AXoOl1Hsg;;Passion of the Nerd
UCeR0n8d3ShTn_yrMhpwyE1Q;;TheReportOfTheWeek
UCeTfBygNb1TahcNpZyELO8g;;Jacob Geller
UCeYvnQaDborjVDabn6qNAYQ;;seme li sin?
UCeZLO2VgbZHeDcongKzzfOw;;8-bit Music Theory
UCedtq0Mn99AK7WLbz8jkb0Q;;Rusty
UCeh-pJYRZTBJDXMNZeWSUVA;;Artifexian
UCekQr9znsk2vWxBo3YiLq2w;;You Suck At Cooking
UCeksXIX5uA23LmESIVt8CZA;;Iain Plays
UCeq_Ml4Iq1aoUsSuTApAkAQ;;The Pethericks
UCez-2shYlHQY3LfILBuDYqQ;;Steve Kaufmann - lingosteve
UCfAOh2t5DpxVrgS9NQKjC7A;;The Onion
UCfIqCzQJXvYj9ssCoHq327g;;How To Make Everything
UCfMJ2MchTSW2kWaT0kK94Yw;;William Osman
UCfV0_wbjG8KJADuZT2ct4SA;;Rich Rebuilds
UCfWpIHmy5MEx2p9c_GJrE_g;;Playing With Prolog
UCf_l8F01d2RtvoVf0R1-lHg;;ann annie
UCfagwFCjnHBYRYIyBnmNAdA;;Armada
UCfdPOTevbfCh_QHsyPeZ8MQ;;Figuring Out Money
UCfgtNfWCtsLKutY-BHzIb9Q;;CityNerd
UCflkKrWXg5F-BR5omd4qr2g;;Replay Value
UCfoK9LI9vmQQ36zqsFZtNJQ;;Airforceproud95
UCftCyvtkr7PEE4_TOAuXm6A;;Crimson Engine
UCfzA-aM_s7u1X0Go9DAjrJA;;竹中大工道具館
UCg3qsVzHeUt5_cPpcRtoaJQ;;圧倒的不審者の極み!
UCg52OrQipnl3G5xmZGNUb_w;;Explanation Point
UCg5UVUMqXeCQ03MelT_RXMg;;Foresight Institute
UCgBVkKoOAr3ajSdFFLp13_A;;KRAZAM
UCgCKYs56-LKEPGQ99DzqQOg;;CurtRichy
UCgFvT6pUq9HLOvKBYERzXSQ;;Davie504
UCgHn5LN2NiQXWMLL4BO70OQ;;Travis Gilbert
UCgI9-PKLovTtsglN9zadKRQ;;Barton Dring
UCgIi12EA6BQ8HKL8QUccsOQ;;Owen Morgan (Telltale)
UCgNOrQWOr3rKR9XPB1Km66Q;;Splash Conference 2017
UCgXdyySqz7qH-lDiVG-7KwA;;"Randy, the Sequel"
UCgb_TbreMgfDdLKkr4yYJHw;;Andrew Millison
UCglyPpj2leAkI40GnG5yddA;;Iglooghost
UCgmtecWyRmWwT6X6CsjDzyA;;NeuralAvocado
UCgv4dPk_qZNAbUW9WkuLPSA;;Atrioc
UCgxg48_pay4R67s-7WOgWFA;;The Local Project
UCh0H_Bie0cJ5zpat63aJ1dQ;;Su Lee
UCh7dz21Xef96jzzLrzjOQzQ;;Juliana Chahayed
UCh8xnRFb7pkMOj50QtDVkgg;;Todd's Nerd Cave
UChBD4NpITiW2CzIz5GwppDA;;Maggie Mae Fish
UChBEbMKI1eCcejTtmI32UEw;;Joshua Weissman
UChFDNnedGN_J1J6PpXwluhQ;;YUSU 유수
UChJpPIRfNNqlB0dwlQQVLVQ;;The Obsolete Geek
UChOrWmBNm5I-qxgBJPLLpSw;;AmazingViz
UChWv6Pn_zP0rI6lgGt3MyfA;;AvE
UChl_NKOs1qqh_x7yJfaDpDw;;Tantan
UChnxLLvzviaR5NeKOevB8iQ;;Red Means Recording
UChpKl3waLmccNeYH9LGYjUQ;;Laufey
UChz2g0uWjiqI_GROs-HUjxg;;NitPix
UCi7l9chXMljpUft67vw78qw;;Sideways
UCiBRvd_WgBNiq0CPmCVSFGw;;Alfo Media
UCiDJtJKMICpb9B1qf7qjEOA;;Adam Savage’s Tested
UCiFAmp2Crv66cQA-9SPje1A;;David Parker
UCiKTCWh0ZhbLyNK7aqn8FeA;;eggy
UCi_7cmJQ_Fsk3j2hAUruGBg;;Pikasprey Yellow
UCidJftClM4kU1196YynvqXg;;Tiny Home Tours
UCijZ49m-lwQRGuF1NNoZrZA;;ToxiCurE
UCilouT5irlCNn2imcCDhhJQ;;ThorHighHeels
UCimiUgDLbi6P17BdaCZpVbg;;exurb1a
UCimytlmjhIrA9mftKvTU-DQ;;Casually Creative
UCivA7_KLKWo43tFcCkFvydw;;Applied Science
UCj1Jtb8xLUzFAm8J-Q1e1MQ;;samuraiguitarist
UCj1VqrHhDte54oLgPG4xpuQ;;Stuff Made Here
UCj4SLNED1DiNPHComZTCbzw;;Rex Krueger
UCj74rJ9Lgl3WTngq675wxKg;;Noodle
UCj7q1yKjZXaRcFJ-Lr-YJhA;;PolyConf
UCj8orMezFWVcoN-4S545Wtw;;Max Derrat
UCjFqcJQXGZ6T6sxyFB-5i6A;;Every Frame a Painting
UCjPJkzjmScrBI3_6ewsKsng;;MDE Never Dies
UCjRzsiP_aDWWLHV4-2LKBtg;;recordingrevolution
UCkK9UDm_ZNrq_rIXCz3xCGA;;Bryan Lunduke
UCkMTo4c_QgaMAURlmQdP-gQ;;Ilyx
UCkSFoxb3PIWx8b70HG3xyMQ;;wikimediaDE
UCkVdb9Yr8fc05_VbAVfskCA;;Matthew Colville
UCkVdkd-DBrvSbpC4gefsnkw;;Bitwig
UCkWfyqjLfHbD0Dd63G8jirA;;Jules Trades
UCkbTTGoBpjX8ogXHCt-aegw;;SORELLE
UCkitABalXafr-NqceQdDXtg;;TVFilthyFrank
UCkm_pIph3Zs7IQKd6JQHIbw;;SHAMIEN
UCkpKS8M7MaZAFewtUz24K3A;;Cybershell
UCkyfHZ6bY2TjqbJhiH8Y2QQ;;thebrainscoop
UCkzY4M9kg2VmqJ2nNcNM8hw;;FreshCap Mushrooms
UCl2mFZoRqjw_ELax4Yisf6w;;Louis Rossmann
UCl68Q7CSkcU_tx_nBiNvf2A;;on4word
UCl7dSJloxuCa9IBFml7sakw;;PolyMars
UCl9OJE9OpXui-gRsnWjSrlA;;Photonicinduction
UClFLXO6ecX-ucJp9gGJYiDw;;Counter Arguments
UClHVl2N3jPEbkNJVx-ItQIQ;;HealthyGamerGG
UClPa3pmqKwApysaYi7B7Nlg;;Tips from a Shipwright
UClRwC5Vc8HrB6vGx6Ti-lhA;;Technology Connextras
UClVfsHNDfmTe66tzYyNFwBQ;;ConfEngine
UClYb9NpXnRemxYoWbcYANsA;;Jason Silva: Shots of Awe
UCl_dlV_7ofr4qeP1drJQ-qg;;Tantacrul
UClcE-kVhqyiHCcjYwcpfj9w;;LiveOverflow
UClq42foiSgl7sSpLupnugGA;;D!NG
UClqhvGmHcvWL9w3R48t9QXQ;;Engineering Explained
UClsFdM0HzTdF1JYoraQ0aUw;;Brick Experiment Channel
UClt01z1wHHT7c5lKcU8pxRQ;;hbomberguy
UClv-03-UmDgnDZDCWmLLH5A;;Alisa
UCm2pbaivKA-9poyXZ4rexrw;;BG Kumbi
UCm325cMiw9B15xl22_gr6Dw;;Beau Miles
UCm4JnxTxtvItQecKUc4zRhQ;;Errant Signal
UCmEbe0XH51CI09gm_9Fcn8Q;;Glass Reflection
UCmHvGf00GDuPYG9DZqQKd9A;;Julian Ilett
UCmM3eCpmWKLJj2PDW_jdGkg;;LeadDev
UCmO-tE6fiQpG0aAydzGDB9g;;psidot
UCmY2tPu6TZMqHHNPj2QPwUQ;;Snoman Gaming
UCmbSGFM9OU8FwjxZCevr6zw;;Ludwig VODs
UCmpHOZ6GqCvcWyPX3svgz-g;;Tiny House Expedition
UCmtyQOKKmrMVaKuRXz02jbQ;;Sebastian Lague
UCn-IoDEPIR8ujknPMLZOyBw;;Mac Lethal
UCn7LyBvG5LEBXK9I4W5dGdA;;That Japanese Man Yuta
UCn8zNIfYAQNdrFRrr8oibKw;;VICE
UCnDZwUFMzqOBcF3bjRfZD-g;;Cocoro Ch by ロート製薬
UCnEiGCE13SUI7ZvojTAVBKw;;Bill Gates
UCnFmWQbVW_YbqPQZGNuq8sA;;Andrew Dotson
UCnbvPS_rXp4PC21PG2k1UVg;;Gaming Historian
UCnkp4xDOwqqJD7sSM3xdUiQ;;Adam Neely
UCno-YPZ8BiLrN0Wbl8qICFA;;markcrilley
UCnoGun4oRPzntFiGdvPSrhQ;;i love trees
UCnoUKype0fVkWtCleYWBT1w;;The Modern Home Project
UCnv0gfLQFNGPJ5MHSGuIAkw;;HACKADAY
UCnxQ8o9RpqxGF2oLHcCn9VQ;;fantano
UCny_vGt2N7_QJ5qBOAHxlcw;;maxmoefoe
UCoFU24KMXmCi4Sl3KIFPSVg;;noopkat
UCoLUji8TYrgDy74_iiazvYA;;Jarvis Johnson
UCoNTMWgGuXtGPLv9UeJZwBw;;Living Big In A Tiny House
UCoOjH8D2XAgjzQlneM2W0EQ;;Jake Tran
UCo_IB5145EVNcf8hw1Kku7w;;The Game Theorists
UCoc2ZM2cYas4DijNdaEJXUA;;30X40 Design Workshop
UCodbH5mUeF-m_BsNueRDjcw;;Overly Sarcastic Productions
UCoebwHSTvwalADTJhps0emA;;Wes Bos
UCoxcjq-8xIDTYp3uz647V5A;;Numberphile
UCp-cSoq5qVVyts7H8rQjV-w;;PAPApinball
UCp68_FLety0O-n9QU6phsgw;;colinfurze
UCp6Ia4JPJTrEJbhQ31EBRmg;;Neversink Farm
UCp9P-Dxf6BC8h12LQDxfk_g;;PinBox 3000
UCpA8SRNrqDpq3Ad7lOCfCLg;;About Here
UCpBIMCPqtHR9krqzha9i0Jw;;TazerLad
UCpIBwBITpXelDgDwe-16zWA;;Front-Trends
UCpIafFPGutTAKOBHMtGen7g;;Gus Johnson
UCpTupIxGdmt3sTpOHjegwxQ;;Anthony Vicino
UCpaCprFX3Lm10g4-7uvj02A;;crymelt
UCpmTgku42WrchhyW61ddkQA;;fishytautog
UCpprBWvibvmOlI8yJOEAAjA;;Cooking with Dog
UCprfnQDSAraGqeEBNWV7NcA;;Matt Click [aFistfulofDice]
UCpyUGZeMUtOvt57UACw3H2g;;Produce Like A Pro
UCq3Wpi10SyZkzVeS7vzB5Lw;;Ichika Nito
UCq6VFHwMzcMXbuKyG7SQYIg;;penguinz0
UCq6aw03lNILzV96UvEAASfQ;;bill wurtz
UCq7dxy_qYNEBcHqQVCbc20w;;Creel
UCqJ-Xo29CKyLTjn6z2XwYAw;;Game Maker's Toolkit
UCqJV0toN29aPdLpotaI9CPA;;Bryan Ropar's Entrepreneur World
UCqKnDDavIqBKZuvgQtYAJsA;;Future Thinkers
UCqMG_BBwxrhLG80Y3yuEu-Q;;XOXO Festival
UCqSHAXN5sqtyE93A-w-8Ddw;;DizastaMusic
UCqVDpXKLmKeBU_yyt_QkItQ;;YouTube Originals
UCqYPhGiB9tkShZorfgcL2lA;;What I've Learned
UCqdUXv9yQiIhspWPYgp8_XA;;Road Guy Rob
UCqmugCqELzhIMNYnsjScXXw;;Vsauce2
UCqpzKFkhhOWnWluy5fIUCkg;;RapperViper VEVO
UCqvklVZgLXvqP6Iz7kQX39g;;Cale Saurage
UCr1fdFXztwacnJ206hMgG7w;;Cas van de Pol
UCr3cBLTYmIK9kY0F_OdFWFQ;;Casually Explained
UCr7lmzIk63PZnBw3bezl-Mg;;The Math Sorcerer
UCr80-ipDpmxXprJ4Kcte2Vw;;cubusdk
UCrPUg54jUy1T_wII9jgdRbg;;Chris Ramsay
UCr_Q-bPpcw5fJ-Oow1BW1NQ;;Kraut
UCrlZs71h3mTR45FgQNINfrg;;Mathemaniac
UCry4eIS1_98ZxFO0geP7xJw;;Matt Dillahunty
UCsCCifMby57qV_UmrYGladQ;;Awesome Restorations
UCsWG9ANbrmgR0z-eFk_A3YQ;;Dezeen
UCsXVk37bltHxD1rDPwtNM8Q;;Kurzgesagt – In a Nutshell
UCs_tLP3AiwYKwdUHpltJPuA;;GOTO Conferences
UCsaGKqPZnGp_7N80hcHySGQ;;Tasting History with Max Miller
UCsdJxGA27BSz7IiPMn9VV1g;;Jack Chapple
UCseUQK4kC3x2x543nHtGpzw;;Brian Will
UCsnVnnNneaz0E7aQPD_o0BQ;;Value Select
UCsvn_Po0SmunchJYOWpOxMg;;videogamedunkey
UCswH8ovgUp5Bdg-0_JTYFNw;;Russell Brand
UCt7fwAhXDy3oNFTAzF2o8Pw;;theneedledrop
UCt8tmsv8kL9Nc1sxvCo9j4Q;;けもみみおーこく「狐」
UCtAIs1VCQrymlAnw3mGonhw;;Flammable Maths
UCtByt51SvEuImGDC2bAiC6g;;Beta64
UCtESv1e7ntJaLJYKIO1FoYw;;Periodic Videos
UCtEwVJZABCd0tels2KIpKGQ;;aarthificial
UCtFuCBKQTItHCwfHRP9LIjQ;;Dr Geoff Lindsey
UCtGoikgbxP4F3rgI9PldI9g;;Super Eyepatch Wolf
UCtHaxi4GTYDpJgMSGy7AeSw;;Michael Reeves
UCtMeM-NXm5Fsne1G-cU1tNw;;Narmak
UCtUbO6rBht0daVIOGML3c8w;;Summoning Salt
UCtWuB1D_E3mcyYThA9iKggQ;;Vulf
UCtYLUTtgS3k1Fg4y5tAhLbw;;StatQuest with Josh Starmer
UCt_oFAUph4_8P3N_Xs-FGHg;;Scamboli Reviews
UCtqxG9IrHFU_ID1khGvx9sA;;All Gas No Brakes
UCtwKon9qMt5YLVgQt1tvJKg;;Objectivity
UCtxCXg-UvSnTKPOzLH4wJaQ;;Coding Tech
UCu6mSoMNzHQiBIOCkHUa2Aw;;Cody'sLab
UCuCkxoKLYO_EQ2GeFtbM_bw;;Half as Interesting
UCuNy42Y5egf07cSiHbF23wg;;Ed Pratt
UCuPgdqQKpq4T4zeqmTelnFg;;kaptainkristian
UCuS_u-4NRy50R9rhnxQbp8A;;Lemma Fundamentals
UCuVQmkiETvqmLviDcBtQw4A;;Nothing
UCul3zsip1IMVyeUySVs4uvg;;PrettySimpleMusic
UCusb0SpT8elBJdbcEJS_l2A;;Tale Foundry
UCvBqzzvUBLCs8Y7Axb-jZew;;Sixty Symbols
UCvK4bOhULCpmLabd2pDMtnA;;Yes Theory
UCvLc83k5o11EIF1lEo0VmuQ;;Sailing SV Delos
UCv_vLHiWVBh_FR9vbeuiY-A;;Historia Civilis
UCvcEBQ0K3UsQ8bzWKHKQmbw;;struthless
UCvgxHFGNdrJFFFP37t6vhxQ;;Sociocinema
UCvjgXvBlbQiydffZU7m1_aw;;The Coding Train
UCvkLh2ZzelX1CXat771mh5A;;Evan Gao
UCvlj0IzjSnNoduQF0l3VGng;;Some More News
UCvmNY5Mce0mNCIEHVZb8Xow;;ATTAR
UCvn5eEsNzr9Yp1KyUoL3mPg;;Dale McKenzie
UCvs_Clo5c1u2hXwv0zEG6rw;;Jessica Kobeissi
UCvwmrPfn8ff-rTlc9YoH7Bg;;Sean Rakidzich
UCw03U5DZGLqvv5elJvXvR0Q;;Bread Boys
UCwBbNaWvAxlwTDdvNqohEgw;;イストク
UCwMjr5HocO6S363x_-jzsmA;;Daniele Tartaglia
UCwRXb5dUK4cvsHbx-rGzSgw;;Derek Banas
UCwV9lBb7IR8x4du_OhlR2HA;;Head[Space]
UCw_BhHFIc7cCdrUeIwUulCQ;;Vít Baisa
UCwagS434ieZhHv1dCzaR4MA;;Michael Pitluk
UCwgKmJM4ZJQRJ-U5NjvR2dg;;george hotz archive
UCwmFOfFuvRPI112vR5DNnrA;;Vsauce3
UCwoucLzzrO-dT96zDPQbpwA;;Well Played
UCwuNTqX1sVLgEVDJn-y1qWQ;;Strong Towns Library
UCx-dJoP9hFCBloY9qodykvw;;BazBattles
UCx0L2ZdYfiq-tsAXb8IXpQg;;Just Write
UCx74vAHCehhLOeQNwbJcGyQ;;Colin Benders
UCxByVUuLdxxiqQVmbOnDEzw;;Erik Grankvist
UCxIu58e9tuENg3EWgQFTfnw;;WOOD DESIGN
UCxQbYGpbdrh-b2ND-AfIybg;;Maker's Muse
UCxXqeNx2u6mLcFiPrX3-G_g;;theweeklyslap
UCxcIDjTcer8WH0TP6THhizw;;P R I M E L O O P S
UCxkMDXQ5qzYOgXPRnOBrp1w;;Mike Zamansky
UCxpi_Z_1emaKs909Oiop_-A;;Stern Pinball
UCxseO_JzIiiJENauW2RmcJQ;;barnabydixon
UCxt9Pvye-9x_AIcb1UtmF1Q;;ashens
UCy0229ISL-677SAuK_1In_A;;하미마미 Hamimommy
UCy0tKL1T7wFoYcxCe0xjN6Q;;Technology Connections
UCy5lOmEQoivK5XK7QCaRKug;;ヨメミ -萌実 -エトラ -テスラ-
UCy6kyFxaMqGtpE3pQTflK8A;;Real Time with Bill Maher
UCyL0RJe41itDFjd70KKZIZQ;;Frugal Aesthetic
UCyNtlmLB73-7gtlBz00XOQQ;;Folding Ideas
UCyWDmyZRjrGHeKF-ofFsT5Q;;Internet Comment Etiquette with Erik
UCyZR5OfKC6sQ6fKHDzlruNw;;Herons Bonsai
UCyp1gCHZJU_fGWFf2rtMkCg;;Numberphile2
UCysZMezyfn6QuDPNlbl6jHQ;;EnthusiastiCon
UCyuAKnN3g2fZ7_R9irgEUZQ;;Exploring History
UCywuq7AxUM4uYrVmSFm3Ezw;;glamourdaze
UCz0l5LJhNQkktxKWcGUtWxg;;mylarmelodies
UCz25mk42tI3qKfN_-97heTw;;Randy LIVE
UCzDE2LGSmJnw53WrZ7mM_Aw;;Living in China
UCzDSEMdSXGXZAhAUCxhGtEw;;fdfg
UCzPIY9Z0kRrJStr-5tbTjEQ;;maxmoefoePokemon
UCzQ1L-wzA_1qmLf49ey9iTQ;;DSLRguide
UCzdg4pZb-viC3EdA1zxRl4A;;Hundred Rabbits
UCzgviV8WkULNua94BJDqI7g;;Engineering Models
UCzjbia0NqUsSL1_-loJihMg;;CinemaStix
UCznv7Vf9nBdJYvBagFdAHWw;;Tim Ferriss
UCzoVCacndDCfGDf41P-z0iA;;JSConf
`.trim().split(/\n/).map(x => x.split(";;")).map(([id,title]) => ({ id, title }))

