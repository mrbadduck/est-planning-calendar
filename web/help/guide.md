<!--
  EST Planning Calendar — help guides, shown in the app's Help drawer (the ? button).
  Parsed by web/help/help-lib.js and checked by scripts/check-help.mjs.

  WRITING GUIDE — you're writing for a program lead who isn't technical:
  - Say "you". Short sentences. Task-first titles ("Add an event or idea").
  - Numbered steps for anything with more than one action.
  - Put on-screen text in [[double brackets]] — it renders as a button-shaped chip,
    and the guard checks that the exact text still appears in the app. Only bracket
    text that is visibly on screen (not tooltips, not counts or names).
  - Refer to things by name, not by position or color.
  - Keep each paragraph, list item and [[Label]] on one line (don't hard-wrap),
    don't start a line with # unless it's a heading, and don't nest **bold**
    and *italic*.
  - No internal names: Coda, Superhuman Docs, Worker, proxy, row, sync, API.
  - Say who can do role-limited things ("Tribal Council only").
  - About 150 words per guide. Link instead of repeating: [text](#guide-id).
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

1. Add it with [[+ New event]]. It starts as a **Draft**, a working plan. It can be just an idea, without a date.
2. When it's ready, open it and click [[Propose]].
3. Tribal Council reviews it and clicks [[Approve]].
4. Tribal Council publishes it to Eventbrite, and members can register.

**Who can do what**

- Anyone who signs in can look at the calendar.
- **Program Leads** add and edit events, propose them, set up potluck and volunteer sign-ups, and see who's coming.
- **Tribal Council** also approves, publishes, reopens and deletes events.

To check your role, click your picture or initials at the top of the page.

> **Tip:** Click [[?]] at the top anytime to come back to these guides. Inside an event, its [[?]] opens the guide for the tab you're on.

## Get around the calendar {#getting-around}

The calendar shows one **program year**, September through August. Use the arrows beside the year (like '26–'27) to move between years.

There are two views:

- [[Overview]]: the whole year at a glance. Each week is split into weeknights (Monday–Thursday) and weekends (Friday–Sunday). Ideas without a firm date sit at the bottom of their month, under **date TBD**.
- [[Calendar]]: a full grid for each month. Ideas without a firm date sit in the [[Ideas]] column.

**Layers.** Turn calendars on and off with the layer buttons: your planning events, plus reference calendars such as Jewish holidays and partner organizations. Reference events are read-only.

On a phone, the year arrows and the layers are in the **⋯** menu.

Click any event to open it. The calendar refreshes itself every minute; click **↻** to refresh right away.

## Read the calendar {#reading-the-calendar}

**Color** shows the program. **Style** shows where an event is in its life:

{{legend}}

A few more things you'll see:

- In Calendar view, a time before a title is the start time.
- **+1** (or +2…) after a title means the event belongs to more than one program.
- A range like **12–18** means "sometime in that window": the event isn't pinned to a day yet.
- Inside an open event, a **Live** badge means it's published on Eventbrite, and **Past** means its date has gone by.

# Planning an event

## Add an event or idea {#add-event}

Program Leads and Tribal Council can add events.

1. Click [[+ New event]], or click an empty spot on the calendar: a day in Calendar view, or a weeknight or weekend lane in Overview. In Calendar view, the **＋** in a month's [[Ideas]] column adds an idea with no firm date.
2. Give it a [[Title]].
3. Under **When**, pick [[Exact date]], [[Date range]] (sometime in a window) or [[Whole month]].
4. Add what you know: [[Program(s)]], [[Leads]], and under **Where**, a venue. Picking a program adds its leads for you. If a venue isn't listed, type its name and choose **＋ New venue**.
5. Click [[Create]].

The event opens in full as a **Draft**. Nothing is public yet, so keep adding details whenever you like.

> **Tip:** Not sure of the date? Choose [[Whole month]] and pin it to a day later.

## Edit an event {#edit-details}

Click an event to open it. It has these tabs:

- [[Details]]: the plan itself. Title, internal description, programs, leads, when and where. The **Public listing** below it unlocks once the event is approved; see [Publish to Eventbrite](#publish).
- [[Planning Notes]]: a Google Doc for your team's notes.
- [[Potluck & Volunteers]]: sign-up slots for members.
- [[Attendees]]: who's coming.

**Changes save by themselves** when you move out of a field. A small label shows [[Saved]], [[Saving…]] or [[Unsaved changes]]. If it says [[Save failed — retry]], click it to try again.

Close the event with **×** or the Esc key. Your last change is saved on the way out.

Once an event is approved, only Tribal Council can change its details. See [From draft to approved](#lifecycle).

## From draft to approved {#lifecycle}

Every event has a status, and the buttons in an open event change with it:

- **Draft**: being planned. Click [[Propose]] when it's ready for Tribal Council.
- **Proposed**: waiting for review. Tribal Council clicks [[Approve]].
- **Approved** 🔒: confirmed. Program Leads can no longer change the details; Tribal Council still can. Next: [Publish to Eventbrite](#publish).
- **Live**: approved and published on Eventbrite.
- **Cancelled**: not happening. Tribal Council can click [[Reopen]] to make it a Draft again.

**To cancel an event**, click [[Cancel event]]. If it's on Eventbrite, the listing comes down too.

Only Tribal Council sees [[Delete]], which removes an event completely. Program Leads cancel instead.

> **Tip:** Click the status label at the top of an open event to come back to this guide.

## Planning notes {#planning-notes}

Each event can have its own Google Doc for internal notes: agenda, to-dos, contacts. It's never shown publicly.

1. Open the event and go to [[Planning Notes]].
2. Click [[Create notes doc]]. The doc is made from our planning template, which can take up to a minute.
3. When it's ready, a preview appears. Click [[Edit in Google Docs]] to write in it.

The preview only shows if you're signed into Google with access to the doc. Program Leads can create a notes doc until the event is approved.

## Potluck & volunteer sign-ups {#signups}

Ask members to bring a dish or take a volunteer shift. They sign up in **gather**, East Side Tribe's member app.

1. Open the event and go to [[Potluck & Volunteers]].
2. Under **Potluck** or **Volunteer**, type a dish or a role, add how many you need (leave it blank for no limit), and click [[Add]].
3. Use the arrows to reorder slots, or **×** to remove one.

To sign someone up yourself, click [[+ Add sign-up]] under a slot.

**When members see them:** slots show up in gather once the event is published. After approval, Program Leads and Tribal Council can preview them there. The **View in gather** icon at the top of an open event takes you straight there.

# After approval

## Publish to Eventbrite {#publish}

Once an event is approved, Tribal Council publishes it. Program Leads can see the listing but not change it; ask Tribal Council for edits.

1. Open the event. In [[Details]], go down to **Public listing**.
2. Fill in [[Public summary]] (one line), [[Public description]] (or click [[Copy from internal]]), [[Capacity]], and [[Address on listing]]: [[Public]] or [[Registrants only]].
3. Click [[Create Eventbrite draft]], then [[Open in Eventbrite]] to check how it looks.
4. Click [[Publish]]. The event is now **Live**, and members can register.

**To change a live listing,** edit the fields, then click [[Update published event]] when it appears. For a draft, click [[Update draft]]. If someone changed the listing directly on Eventbrite, you'll be asked before your version replaces theirs.

Cancelling an event takes its listing down.

## See who's coming {#attendees}

Program Leads and Tribal Council can open [[Attendees]] in any event. It lists everyone who registered on Eventbrite, plus anyone who signed up for a potluck or volunteer slot.

- Narrow the list with the filters, such as [[Registered]], [[Signed up, not registered]] or [[Members]]. Each sign-up slot gets a filter too.
- **Member** marks an active member. **Not registered** means someone signed up for a slot but hasn't registered on Eventbrite.
- Click [[Refresh]] for the latest registrations.

**To email people:**

1. Check the boxes for the people you want, or the box at the top of the list for everyone in the filter.
2. Click [[Email]] to open your own email app with them in BCC, or [[Copy emails]] to paste the addresses anywhere.

The app never sends email itself. It comes from your own account.

## Share a link {#share-link}

**To an event:** open it and click its link icon (it says *Copy link* when you point at it). The link opens that event, on the same tab, for anyone who's signed in.

**To a guide:** open the guide and copy the address from your browser's address bar. It opens straight to that guide, even for someone who hasn't signed in yet. It's handy for welcoming a new lead.

# Help

## Common problems {#troubleshooting}

**I can't sign in.** Try [[Continue with Google]]. If you use [[Email me a link]], open the email on the same device, and check your spam or junk folder.

**I can see the calendar but can't add or edit.** Your account needs the Program Lead role. Click your picture or initials to see your role, then ask Tribal Council to add you. Reload the page once they have.

**Tribal Council:** after giving someone a role, click [[Refresh roles & people]] in your account menu so it takes effect right away.

**I can't find an event.** Check the program year, make sure its layer is on, and click **↻** to refresh. Undated ideas sit under **date TBD** (Overview) or in the [[Ideas]] column (Calendar).

**My change didn't stick.** Look for [[Saved]] in the open event. If it says [[Save failed — retry]], click it.

**Everything is grayed out.** The event is approved (only Tribal Council can edit it) or cancelled (Tribal Council can reopen it).

## Suggest an improvement {#feedback}

Something confusing, or an idea that would help? Tell us.

1. Click [[Feedback / Ideas]] at the top of the page.
2. Type your idea and click [[Submit]], or click **▲** to add your vote to someone else's.

Each idea shows where it stands: **New**, **Planned**, **Shipped** or **Declined**.

The *coming soon* tabs inside an event have their own idea boards. Tell us what you'd want there.
