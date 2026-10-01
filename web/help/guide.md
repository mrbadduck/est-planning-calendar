<!--
  EST Planning Calendar — help guides, shown in the app's Help drawer (the ? button).
  Parsed by web/help/help-lib.js and checked by scripts/check-help.mjs.

  WRITING GUIDE — you're writing for a program lead who isn't technical:
  - Say "you". Short sentences. Task-first titles ("Add an event or idea").
  - Numbered steps for anything with more than one action.
  - Put on-screen text people click, pick or fill in (buttons, tabs, fields, filters,
    menu items) in [[double brackets]] — it renders as a button-shaped chip, and the
    guard checks that the exact text still appears in the app. Only bracket text
    that is visibly on screen (not tooltips, not counts or names). Things people only
    read (statuses, badges, headings) go in **bold**; the guard can't check those, so
    re-read them against the app whenever the screens change.
  - Refer to things by their on-screen name. You may add a coarse place that is the
    same on a phone and a computer ("at the top of the page", "at the top of an open
    event", "in the menu under your picture"); icons and pictures with no text need
    one. Never point at a control with left/right, above/below, corners or color.
  - Keep each paragraph, list item and [[Label]] on one line (don't hard-wrap),
    don't start a line with # unless it's a heading, and don't nest **bold**
    and *italic*.
  - No internal names: Coda, Superhuman Docs, Worker, proxy, row, sync, API.
  - Say who can do role-limited things, using the app's role names: Member,
    Program Lead, Tribal Council.
  - Warn before anything with no undo, or that only Tribal Council can undo
    (Delete, Cancel event, removing a slot).
  - Promise only what the app does: check the trigger, role and confirmation behind
    every "saves", "appears", "notifies" or "can".
  - About 150 words per guide; one that carries warnings, or the Common problems
    FAQ, can run to ~250. Past that, split it. Link instead of repeating:
    [text](#guide-id).
  - These files are public: no member names, emails or private links.

  FORMAT — "# Group" starts a group. "## Title {#id}" starts a guide; ids are
  permanent (they're in shared links). Inside a guide: paragraphs, "### Subhead",
  "- " bullets, "1. " steps, **bold**, *italic*, [text](https://…), [text](#id),
  "> " tip callouts, and {{legend}} (the live color/status key) on its own line.
-->

# Getting started

## Welcome to the Planning Calendar {#welcome}

This is where East Side Tribe leaders plan the whole program year together, before anything goes public.

Every event follows the same path:

1. Add it with [[+ New event]]. It starts as a **Draft**, a working plan. It can be a rough idea without an exact date.
2. When it's ready, open it and click [[Propose]].
3. Tribal Council reviews it and clicks [[Approve]].
4. Tribal Council publishes it to Eventbrite, where anyone can register.

**Who can do what**

- Anyone who signs in can look at the calendar.
- **Program Leads** add, edit, propose and cancel events, set up potluck and volunteer sign-ups, and see who's coming.
- **Tribal Council** does all that too, and also approves, publishes, reopens and deletes events, and can edit them after approval.

To check your role, click your picture or initials at the top of the page.

> **Tip:** Click [[?]] at the top of the page anytime to come back to these guides. In an open event, its [[?]] opens the guide for the tab you're on.

## Get around the calendar {#getting-around}

The calendar shows one **program year**, September through August. Use the arrows beside the year (like '26–'27) to move between years.

There are two views:

- [[Overview]]: the whole year at a glance. Each week has two lanes: weeknights (Monday–Thursday), then weekends (Friday–Sunday). Ideas without a firm date sit at the bottom of their month, under **date TBD**.
- [[Calendar]]: a full grid for each month. Ideas without a firm date sit in the [[Ideas]] column.

**Layers.** Click a layer's name to show or hide it: [[Planning events]] (your plans), plus reference calendars such as Jewish holidays and partner organizations. A hidden layer looks faded and crossed out. Reference events are read-only.

On a phone, the year arrows and the layers are in the **⋯** menu.

Click any event to open it. The calendar refreshes itself every minute; click **↻** to refresh right away.

## Read the calendar {#reading-the-calendar}

**Color** shows the program. **Style** shows where an event is in its life:

{{legend}}

A few more things you'll see:

- In Calendar view, a time before a title is the start time, on a 24-hour clock (18:30 is 6:30 pm).
- **+1** (or +2…) after a title means the event belongs to more than one program.
- After an idea's title, a range like **12–18** means sometime in that window, and **month** means sometime that month. (In Overview, the numbers at the start of each week are just that week's dates.)
- In an open event, a **Live** badge means it's published on Eventbrite, and **Past** means its date has gone by.

# Planning an event

## Add an event or idea {#add-event}

Program Leads and Tribal Council can add events.

1. Click [[+ New event]], or click an empty spot on the calendar: a day in Calendar view, or a weeknight or weekend lane in Overview. In Calendar view, clicking empty space in a month's [[Ideas]] column adds a whole-month idea.
2. Give it a [[Title]].
3. Under **When**, pick [[Exact date]], [[Date range]] (sometime in a window) or [[Whole month]]. A new exact-date event starts at 6:30–8:00 pm, so check the times.
4. Add what you know: [[Program(s)]], [[Leads]], and under **Where**, a venue. Picking a program adds its leads for you. If a venue isn't listed, pick [[Any]] to search every venue, or type its name and choose **＋ New venue**.
5. Click [[Create]].

The event opens in full as a **Draft**. Nothing is public yet, so keep adding details whenever you like.

> **Tip:** Not sure of the date? Choose [[Whole month]] and pin it to a day later.

## Edit an event {#edit-details}

Click an event to open it. It has these tabs:

- [[Details]]: the plan itself. Title, internal description, programs, leads, when and where. Below it, **Public listing** holds the Eventbrite listing, which Tribal Council fills in after approval; see [Publish to Eventbrite](#publish).
- [[Planning Notes]]: a Google Doc for your team's notes.
- [[Potluck & Volunteers]]: sign-up slots for members.
- [[Attendees]]: who's coming.

**Changes save by themselves** when you move out of a field. A small label shows **Saved**, **Saving…** or **Unsaved changes**. If it says [[Save failed — retry]], click it to try again.

Close the event with **×** or the Esc key. Your last change is saved on the way out.

Once an event is approved, only Tribal Council can change its details, but Program Leads can still manage its potluck and volunteer sign-ups. See [From draft to approved](#lifecycle).

## From draft to approved {#lifecycle}

Every event has a status, and the buttons in an open event change with it:

- **Draft**: being planned. Click [[Propose]] when it's ready for Tribal Council.
- **Proposed**: waiting for review. You can still edit it. Tribal Council clicks [[Approve]].
- **Approved** 🔒: confirmed. Program Leads can no longer change the details; Tribal Council still can. Next: [Publish to Eventbrite](#publish).
- **Live**: approved and published on Eventbrite.
- **Cancelled**: not happening. Tribal Council can click [[Reopen]] to make it a Draft again.

The app doesn't tell Tribal Council when something is proposed, so let them know it's ready.

**To call an event off**, click [[Cancel event]] and confirm. Program Leads and Tribal Council can do this at any stage, even after it's live. If it's on Eventbrite, the listing comes down too, so if people have registered, email them from [[Attendees]] before you cancel. Only Tribal Council can bring it back to planning, with [[Reopen]], and that doesn't put it back on Eventbrite.

Only Tribal Council sees [[Delete]]. It removes the event right away, with no undo, and doesn't touch Eventbrite, so use [[Cancel event]] for anything that's been published.

> **Tip:** Click the status label at the top of an open event to come back to this guide.

## Planning notes {#planning-notes}

Each event can have its own Google Doc for your team's notes: agenda, to-dos, contacts. It never appears on the Eventbrite listing.

1. Open the event and go to [[Planning Notes]].
2. Click [[Create notes doc]]. It's made from our planning template and can take a minute or two to appear.
3. When it's ready, a preview appears. Click [[Edit in Google Docs]] to write in it.

The preview only shows if you're signed into Google with access to the doc. If it's blank, click [[Edit in Google Docs]] and request access there. Program Leads can create a notes doc until the event is approved.

## Potluck & volunteer sign-ups {#signups}

Ask members to bring a dish or take a volunteer shift. They sign up in **gather**, East Side Tribe's member app.

1. Open the event and go to [[Potluck & Volunteers]].
2. Under **Potluck** or **Volunteer**, type a dish or a role, add how many you need (leave it blank for no limit), and click [[Add]].
3. Use the arrows to reorder slots, or **×** to remove one. Removing a slot drops everyone signed up for it, with no undo.

To sign someone up yourself, click [[+ Add sign-up]] under a slot, pick their name from the list, and click [[Add]].

**When members see them:** slots show up in gather once the event is published. After approval, Program Leads and Tribal Council can preview them there. The **View in gather** icon at the top of an open event takes you straight there.

# After approval

## Publish to Eventbrite {#publish}

Once an event is approved, Tribal Council publishes it. Program Leads can see the listing but can't change it.

### Before you publish

- It needs an exact date and a start time. Whole-month, date-range and all-day events can't go on Eventbrite.
- Pick its venue from the list. With no venue, a **＋ New venue** name, or a venue with no street address on file, Eventbrite lists it as online. After you create the Eventbrite draft, check it doesn't say **Online**; if it does, fix the location on Eventbrite.

### Publish

1. In [[Details]], go down to **Public listing**.
2. Fill in [[Public summary]] (one line), [[Public description]] (or click [[Copy from internal]] to start from the internal description) and [[Capacity]].
3. Under [[Address on listing]], pick [[Public]] or [[Registrants only]]. Registrants only shows just the city, so send the address yourself from [[Attendees]].
4. Click [[Create Eventbrite draft]], then [[Open in Eventbrite]] to check it (you'll need East Side Tribe's Eventbrite login).
5. Click [[Publish]]. The event is now **Live**, and anyone can register.

**To change a live listing,** edit the **Published listing** fields and click [[Update published event]] when it appears; it also sends the event's current title, date, time and venue. For an Eventbrite draft that isn't live yet, click [[Update draft]]. If someone changed the listing directly on Eventbrite, you'll be asked before your version replaces theirs.

> **Heads-up:** changing only the title, date, time or venue doesn't show that button yet, so make the same change on Eventbrite too.

Cancelling an event takes its listing down.

## See who's coming {#attendees}

Program Leads and Tribal Council can see who's coming in any event's [[Attendees]] tab: each Eventbrite registration with its ticket count, plus anyone who signed up for a potluck or volunteer slot.

- Narrow the list with the filters, such as [[Registered]], [[Signed up, not registered]] or [[Members]]. Each slot that has sign-ups gets a filter too.
- **Member** marks an active member. **Not registered** means someone signed up for a slot but hasn't registered on Eventbrite. **Not in People** means we don't have the email they registered with, often a guest.
- Click [[Refresh]] for the latest registrations.

**To email people:**

1. Check the boxes for the people you want, or the box at the top of the list for everyone in the filter. [[Email]] and [[Copy emails]] appear once someone is checked.
2. Click [[Email]] to start a message in your email app, with everyone in BCC so they can't see each other's addresses. For a long list, or if the wrong app opens, click [[Copy emails]] and paste them in yourself.

The app never sends email itself. It comes from your own account.

## Share a link {#share-link}

**To an event:** open it and click its link icon at the top (it says *Copy link* when you point at it). The link opens that event, on the same tab. If the person has to sign in with an emailed link first, they'll land on the calendar; have them open your link again.

**To a guide:** open the guide and copy the address from your browser's address bar. It opens straight to that guide, even for someone who hasn't signed in yet. It's handy for welcoming a new lead.

# Help

## Common problems {#troubleshooting}

**I can't sign in.** Try [[Continue with Google]]; if no Google window opens, allow pop-ups for this site. If you use [[Email me a link]], open the email on the same device, and check your spam or junk folder. Still stuck? Click [[Email us]] on the sign-in screen.

**I can see the calendar but can't add or edit.** You need the Program Lead role. Click your picture or initials to see your role. If it says **Member**, ask Tribal Council to make you a Program Lead. If it says **Not a recognized lead**, we don't have the email you signed in with: [[Sign out]] and sign in with the one East Side Tribe uses to reach you, or ask Tribal Council to add this one. Reload the page once they have.

**Tribal Council:** after giving someone a role, click [[Refresh roles & people]] in the menu under your picture or initials. It takes effect within about a minute.

**I can't find an event.** Check the program year, make sure [[Planning events]] isn't crossed out, and click **↻** to refresh. Undated ideas sit under **date TBD** (Overview) or in the [[Ideas]] column (Calendar).

**My change didn't stick.** Look for **Saved** in the open event. If it says [[Save failed — retry]], click it. If a message says a change didn't save after you closed the event, open the event and make the change again.

**Everything is grayed out.** The event is approved (only Tribal Council can change it), it's cancelled (Tribal Council can reopen it), or your account doesn't have the Program Lead role yet (see above).

**Only Program(s), Leads and Where are grayed out.** Their lists haven't loaded yet. Close and reopen the event in a moment, or reload the page.

## Suggest an improvement {#feedback}

Something confusing, or an idea that would help? Tell us.

1. Click [[Feedback / Ideas]] at the top of the page.
2. Type your idea and click [[Submit]], or click **▲** to add your vote to someone else's.

Each idea shows where it stands: **New**, **Planned**, **Shipped** or **Declined**.

Inside an event, the coming-soon tabs ([[Budget & expenses]], [[Comms]] and [[Feedback]]) have their own idea boards. Tell us what you'd want there.
