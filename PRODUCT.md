# Product

## Register

product

## Users

People who want a calm, ad-free way to follow podcasts, YouTube channels, and video/audio RSS feeds in one place. They arrive to search for
a channel, browse a topic, or catch up on their own subscribed feed. Context: a personal media app, used at leisure on desktop and mobile,
often in a dim room ("lean back" viewing), where the player is the point.

## Product Purpose

Telecast is a minimalist, free YouTube/podcast alternative — an aggregator that turns any RSS feed into a watchable/listenable channel.
Success = a user finds good channels fast, subscribes, and plays episodes without friction, ads, or algorithmic noise. Curation (`featured`,
topic tags) and discovery (search, seeded channels) feed the browse experience.

## Brand Personality

Broadcast Editorial. Three words: **editorial, warm, on-air**. It should feel like a late-night public-broadcast control room — an editor's
pick, not an algorithm's feed. Serif display type (Lora) for authored warmth, mono labels (JetBrains Mono) for the broadcast/technical
register, and a single **signal amber** accent that means "live / selected / on air". Confident and quiet; the content is the star, the
chrome recedes.

## Anti-references

- Generic dark SaaS dashboards (flat gray, blue accent, card-grid sameness).
- YouTube/Spotify's dense, algorithmic, engagement-maximizing surfaces.
- The monochrome-gray look this UI regressed into (accent flattened to `#ccc`).
- 2023 AI tells: uppercase tracked eyebrows over every section, gradient text, glassmorphism as default, side-stripe accent borders.

## Design Principles

- **Amber means live.** Reserve the accent for the on-air / selected / primary-action moments. Everywhere else, let warm near-neutral
  surfaces and type carry the design.
- **Content is the broadcast.** Thumbnails, titles, and the player lead; chrome is quiet.
- **Editorial hierarchy.** Serif display + mono labels + sans body, used consistently — hierarchy from type and space, not from boxes and
  lines.
- **Legible in the dark, legible in the light.** Both themes are first-class; contrast is verified, never "elegant gray on gray".
- **Calm motion.** Motion signals state (on-air pulse, hover lift, load); no decorative choreography.

## Accessibility & Inclusion

Body text ≥ 4.5:1 contrast in both themes; large text ≥ 3:1. Respect `prefers-reduced-motion` (the on-air pulse, spinners, and hover
transitions all have reduced-motion fallbacks). Respect `prefers-color-scheme` for light/dark. Keyboard focus is always visible (amber focus
ring).
