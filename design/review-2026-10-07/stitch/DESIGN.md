# CDF Enterprise Design System (from CDF_Design_Tokens.json v1.1)

Cultural Development Fund (Saudi Arabia) case-management and whistleblowing platform. Bilingual: Arabic (RTL, primary) and English (LTR). Tone: institutional, calm, trustworthy, minimal ("Clarity / Resonant Design / Adaptability"). Restrained surfaces, reduced radii and shadows.

## Colors

- Primary / Cinder Black #101820 (primary buttons, table headers, header bar text, active step). Primary text on it: #FFFFFF.
- Background #F3F4F4; Surface #FFFFFF; Surface subtle #F8F8F7; Border Warm Gray #D7D2CB.
- Text primary #101820; text secondary #5E646B. Never use #8B9095 for body text.
- Brand accents (tints, used sparingly for highlights, illustrations, chips): Powder Blue #BBDDE6, Wistful Blue #A5B0E3, Chardonnay Yellow #FDD086, Light Salmon #FA9370, Jetstream Green #B5E1C4.
- Status: success #22633D on #E6F4EA; warning #7A4A00 on #FDF3DF; danger #8A2F1B on #FBE9E4; info #245667 on #E5F2F6. Focus ring #4B6FFF, 3px.
- Dark mode: background #101820, surface #19212B, elevated #252E38, border #46505A, text #FFFFFF / #D8DADD, primary button white with cinder text.

## Typography

Arabic-capable humanist sans (IBM Plex Sans / IBM Plex Sans Arabic). Display 32/39, H1 24/29, H2 20/24, H3 16/20, Body1 14/17, Body2 12/15, Button 14-18. Semibold for headings, regular body.

## Shape and spacing

Radius sm 4, md 6 (buttons, inputs), lg 8 (cards), xl 12. Spacing scale 4,8,12,16,20,24,32,40,48,64. Hairline 1px borders; elevation 0 8px 24px rgba(16,24,32,.08) for cards only.

## Components

- Header: white bar, CDF logo at inline-start, primary nav, utilities (language switch, sign out) at inline-end.
- Tables: Cinder Black header row with white text, neutral white rows, hairline warm-gray dividers, generous padding.
- Buttons: primary solid cinder; secondary white with warm-gray border; min height 44px.
- Chips/badges: tinted brand backgrounds with dark text.
- Cards: white, 8px radius, warm-gray border.
- All layouts mirror for RTL using logical start/end.
