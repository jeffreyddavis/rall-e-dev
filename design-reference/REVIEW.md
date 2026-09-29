# Rally design implementation notes

Source: user-provided `Rally.zip`, exported from the Rally Figma file. Reviewed all frames via a contact sheet and inspected the welcome, landing, single/multiple invitations, and confirmation frames at full size.

## Direction

- Sky-blue brand (`#51b3f5`), warm near-white background, charcoal type, round buttons and cards.
- Italic Rall-e wordmark and a blue circular R avatar.
- Centered landing page with a three-photo collage, short signup screens, photo-led invitation cards, and a blue reply/vote confirmation with a signup prompt.
- Mike's behavior note, confirmed by Jeff: **the primary experience happens over text**. Web pages support signup, invitation details, votes and RSVP. The browser conversation is a presenter preview, not a replacement messaging product.

## Implemented in this pass

Responsive landing/welcome/profile/phone/code/Google preview screens; input error and disabled states; new blue/white branding; supplied photos in event cards; responsive personal guest pages; invited group and overview sections; working RSVP and vote confirmations; signup prompt; photo choices for suggestions; shared host state preserved.

The exports are flattened PNGs. The photo regions are displayed using SVG viewBoxes referencing three original frames in `public/design`; interactive text, buttons and layout are real HTML. Browser bars, phone frames, keyboards and device status icons in the design are not copied into the webpage. Native photo exports can replace the frame references later.

## Prototype boundaries

Phone verification uses the displayed demo code `123456`; no OTP is sent. Email/phone/last-name fields are preview-only and are not persisted. Google connection is disabled and can be skipped; no Gmail/Calendar access is requested. The privacy copy describes only implemented behavior. The landing action opens the demo, not an unimplemented waiting-list service.

Existing fictional event fixtures remain clearly labeled sample outings; reference photos do not establish real availability, booking or artist participation. Nature and museum use the prior original illustrations because the archive supplied photos only for dining, comedy and nightlife.

Two-way texting is built: hosts can plan and guests can RSVP, suggest, vote, ask and chat by SMS, with group updates on every change. It is exercised in the `/lab` simulator and in tests. Outbound uses the verified A2P messaging service once an allowlist and live mode are set. Real inbound still waits on routing, because the current sender’s webhook belongs to Field CRM. Don't describe live SMS as working until a real tester round-trip has been verified.
