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
2. When it's ready, open it and click [[Propose to council]].
3. Tribal Council reviews it and clicks [[Approve]].
4. You add it to Eventbrite as a private draft, check it, then publish it so anyone can register.

**Who can do what**

- Anyone who signs in can look at the calendar.
- **Program Leads** add, edit, propose and delete events, put them on Eventbrite and publish them, cancel published events, set up potluck and volunteer sign-ups, and see who's coming. They can keep editing after approval.
- **Tribal Council** does all that too, and also approves and reopens events.

To check your role, click your picture or initials at the top of the page (on a phone, tap **☰**).

> **Tip:** Click [[?]] at the top of the page anytime to come back to these guides (on a phone, tap **☰**, then [[Help]]). In an open event, its [[?]] opens the guide for the tab you're on.

## Get around the calendar {#getting-around}

The calendar shows one **program year**, September through August. Use the arrows beside the year (like '26–'27) to move between years.

There are three views:

- [[Overview]]: the whole year at a glance. Each week has two lanes: weeknights (Monday–Thursday), then weekends (Friday–Sunday). Ideas without a firm date sit at the bottom of their month, under **date TBD**.
- [[Calendar]]: a full grid for each month. Ideas without a firm date sit in the [[Ideas]] column.
- [[List]]: every day that has something on it, in order. Holidays and other reference dates share one line under their day. Ideas without a firm date close out their month under **Date TBD**.

**On a phone**, you always get the list. Tap **☰** at the top for everything else: your account, [[Help]], [[Feedback / Ideas]], the program year, and which calendars to show.

**Layers.** Click **⚙** at the top (on a phone, **☰**) to choose what the calendar shows: [[Planning events]] (your plans), plus reference calendars such as Jewish holidays and partner organizations. A hidden layer looks faded and crossed out. Reference events are read-only. Your choices are remembered on this device, and so is the view you last picked on a computer.

Click any event to open it. The calendar refreshes itself every minute and whenever you come back to it; on a computer, click **↻** to refresh right away.

## Read the calendar {#reading-the-calendar}

**Color** shows the program. **Style** shows where an event is in its life:

{{legend}}

A few more things you'll see:

- In Calendar view, a time before a title is the start time, on a 24-hour clock (18:30 is 6:30 pm).
- **+1** (or +2…) after a title means the event belongs to more than one program.
- After an idea's title, a range like **12–18** means sometime in that window, and **month** means sometime that month. (In Overview, the numbers at the start of each week are just that week's dates.)
- In an open event, a **Live** badge means it's published on Eventbrite, and **Past** means its date has gone by. Once an approved event is past, its details lock.

# Planning an event

## Add an event or idea {#add-event}

Program Leads and Tribal Council can add events.

1. Click [[+ New event]] (on a phone, tap the round **+** button that floats over the list), or point at a day in Calendar view, or a weeknight or weekend lane in Overview, and click the **+** that appears. On a touch screen, those **+** buttons always show. In Calendar view, the **+** at the top of a month's [[Ideas]] column adds a whole-month idea.
2. Give it a [[Title]].
3. Under **When**, pick [[Exact date]], [[Date range]] (sometime in a window) or [[Whole month]]. A new exact-date event starts at 6:30–8:00 pm, so check the times.
4. Add what you know: [[Program(s)]], [[Leads]], and under **Where**, a venue. Picking a program adds its leads for you. If a venue isn't listed, set **Venue type** to [[Any]] to search every venue, or type its name and choose **＋ New venue**.
5. Click [[Create]].

The event opens in full as a **Draft**. Nothing is public yet, so keep adding details whenever you like.

> **Tip:** Not sure of the date? Choose [[Whole month]] and pin it to a day later.

## Edit an event {#edit-details}

Click an event to open it. It has these tabs:

- [[Details]]: what goes on the Eventbrite listing, in the order people see it: [[Title]], [[Summary]], [[Description]], **When**, **Where** and [[Capacity]]. Summary, Description, Capacity and [[Address on listing]] open once the event is approved; see [Put an event on Eventbrite](#publish).
- [[Planning]]: what only the planning team sees: [[Program(s)]], [[Leads]], [[Internal description]] and a Google Doc for your planning notes.
- [[Potluck & Volunteers]]: sign-up slots for members.
- [[Attendees]]: who's coming.

**At the top of an open event** are its title, its first program (in that program's color, with **+1** and so on when there are more), and under them the first line of its [[Internal description]].

**At the bottom of an open event**, a row of steps shows how far it has got: **Draft**, **Proposed**, **Approved**, **On Eventbrite**, **Published**. The label at the top of the event always matches the step. On [[Details]], it says what's next, with one button for the next step. The **⋮** button (it says *More actions* when you point at it) holds the rest, such as [[Delete event]]. On the other tabs, only **⋮** shows.

**Changes save by themselves** when you move out of a field. While a change is saving, the button at the bottom says **Saving…**, and it waits until everything has saved. A save can take up to half a minute; when it's slow, the button says **Still saving…**. Your change is safe meanwhile. When nothing says Saving, everything is saved. If [[Save failed — retry]] appears beside the button, click it to try again.

The same button shows a step that's under way, such as **Saving…** after you propose or approve, **Cancelling…** or **Deleting…**.

**The icons beside each field name** show what's private, what goes on Eventbrite, and what's missing; see [Field icons](#field-markers).

You can keep editing after approval, and the event doesn't need approving again. Close it with **×** or the Esc key; your last change is saved on the way out.

## Field icons {#field-markers}

In [[Details]] and [[Planning]], each field name has one icon that shows where it goes. Point at an icon to see what it means. The icons are:

- A crossed-out eye: private. Only the planning team sees it; it never goes to Eventbrite.
- A gray clock: public. It goes on the Eventbrite listing once the event is added to Eventbrite.
- A green check: it's on Eventbrite, and it matches what Eventbrite has.
- Amber arrows: you changed it here, and Eventbrite doesn't have the change yet.
- Gray arrows: it's on Eventbrite, but the app hasn't compared it yet. That happens after the next update.

Two tags can appear too:

- **Needed for Eventbrite**: the next step is waiting on this field. See [What Eventbrite needs](#publish).
- **● Not on Eventbrite yet**: you changed it since the last update. What Eventbrite still has shows under the field, until you click [[Update draft]] or [[Update listing]].

The icons and tags update once the field has saved.

## From draft to published {#lifecycle}

The steps at the bottom of an open event show where it is:

- **Draft**: being planned. Click [[Propose to council]] when it's ready.
- **Proposed**: waiting for Tribal Council. You can keep editing. Tribal Council clicks [[Approve]].
- **Approved**: you can still edit it, with no need to approve it again. Next: [[Add to Eventbrite]].
- **On Eventbrite**: a private draft listing. Nobody can see it or register yet. Next: [[Publish]].
- **Published**: public on Eventbrite, and registration is open. The label at the top of the event says **Live**.

The app doesn't tell Tribal Council when something is proposed, so let them know it's ready.

**Delete or cancel, never both.** Both are in **⋮**.

- **Before it's published**, use [[Delete event]]. It removes the event right away, with no undo. Program Leads and Tribal Council can do this. If the event is on Eventbrite as a private draft, that draft is deleted too.
- **Once it's published**, Delete is gone. Use [[Cancel event…]], which takes the listing down. If people have registered, see [Change or take down a listing](#publish-changes).
- **A cancelled event** can be brought back to planning by Tribal Council with [[Reopen]], which doesn't put it back on Eventbrite. Tribal Council can also delete it.

**After the date,** an approved event is history: the fields on [[Details]] and [[Planning]] lock and there's nothing left to do at the bottom. Its notes doc, sign-ups and [[Attendees]] still work.

> **Tip:** Click the status label at the top of an open event to come back to this guide.

## Planning and notes {#planning-notes}

The [[Planning]] tab holds what only the planning team sees. None of it goes on Eventbrite.

- [[Program(s)]] and [[Leads]]. Picking a program adds its leads for you.
- [[Internal description]]: a short description for quick reference. Its first line shows at the top of the event.
- A Google Doc for longer notes: agenda, to-dos, contacts.

To add the doc:

1. Open the event and go to [[Planning]].
2. Click [[Create notes doc]]. It's made from our planning template and can take a minute or two to appear.
3. When it's ready, a preview appears. Click [[Edit in Google Docs]] to write in it.

The preview only shows if you're signed into Google with access to the doc. If it's blank, click [[Edit in Google Docs]] and request access there. Program Leads and Tribal Council can create one at any stage except Cancelled.

## Potluck & volunteer sign-ups {#signups}

Ask members to bring a dish or take a volunteer shift. They sign up in **gather**, East Side Tribe's member app.

1. Open the event and go to [[Potluck & Volunteers]].
2. Under **Potluck** or **Volunteer**, type a dish or a role, add how many you need (leave it blank for no limit), and click [[Add]].
3. Use the arrows to reorder slots, or **×** to remove one. Removing a slot drops everyone signed up for it, with no undo.

To sign someone up yourself, click [[+ Add sign-up]] under a slot, pick their name from the list, and click [[Add]].

**When members see them:** slots show up in gather once the event is published. After approval, Program Leads and Tribal Council can preview them there. The **View in gather** icon at the top of an open event takes you straight there.

# After approval

## Put an event on Eventbrite {#publish}

Once an event is approved, Program Leads and Tribal Council can put it on Eventbrite, in two steps:

- [[Add to Eventbrite]] creates a **private draft**. Nobody can see it or register.
- [[Publish]] makes it public and opens registration.

### What Eventbrite needs

Until these are done, the button can't be clicked. The bottom of the event lists what's left; click an item to jump to its field.

- Approval from Tribal Council, and a title.
- An exact date that hasn't passed, with a start time and a later end time. Date ranges, whole months and all-day events can't go on Eventbrite.
- A [[Capacity]] of at least 1: how many free tickets Eventbrite offers.
- A venue picked from the list, not a new name you typed in (ask Tribal Council to add it to the list). With no venue, Eventbrite lists the event as online.
- A street address saved on the venue, unless [[Address on listing]] is [[Registrants only]].
- To publish, a [[Description]] too. [[Summary]] is optional.

**At a private home,** [[Address on listing]] starts as [[Registrants only]], so the public sees just the city; send the address yourself from [[Attendees]]. Choosing [[Public]] there shows a warning.

### Steps

1. In [[Details]], fill in [[Summary]], [[Description]] and [[Capacity]]. [[Copy internal description]] starts you off from the internal one, but take out planning notes first: this text goes public.
2. Click [[Add to Eventbrite]].
3. Click [[Preview listing]] to see exactly what Eventbrite has.
4. Click [[Publish]]. Anyone can now register.

Every listing has free General Admission tickets. Paid tickets and discount codes are coming later.

## Change or take down a listing {#publish-changes}

**To change it,** edit the fields as usual. Each changed field says **Not on Eventbrite yet** until you click [[Update draft]] (private draft) or [[Update listing]] (published). If you close the event first, you're asked; [[Close anyway]] leaves the changes off Eventbrite.

- If someone edited the listing directly on Eventbrite, a notice says updating will replace their changes.
- Editing [[Description]] here turns it into plain text on Eventbrite: any bold, links or lists added there are removed.

**To tell registrants.** When [[Update listing]] changes the date, time or venue and people have registered, you're offered [[Email registrants]]. It opens a message in your email app with the changes written in and everyone in BCC. For a long list, it copies the emails instead: paste them into BCC. [[Not now]] skips it. The app never sends email itself.

**To take it down,** use **⋮**:

- [[Unpublish (back to private)]] makes it a private draft again. It only works while nobody has registered.
- [[Cancel event…]] takes the listing down and cancels the event.

Once people have registered, Eventbrite won't let the app unpublish or cancel it. Ask Tribal Council to cancel it on Eventbrite, which refunds and emails the registrants (it needs East Side Tribe's Eventbrite login). Then click [[Cancel event…]] here again.

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

**I can't sign in.** If [[Continue with Google]] opens no window, allow pop-ups for this site. With [[Email me a link]], open the email on the same device, and check spam too. Still stuck? Click [[Email us]] on the sign-in screen.

**I can see the calendar but can't add or edit.** You need the Program Lead role; click your picture or initials (on a phone, tap **☰**) to see yours. **Member**: ask Tribal Council to make you a Program Lead. **Not a recognized lead**: we don't know that email, so [[Sign out]] and use the one East Side Tribe emails you at, or ask Tribal Council to add it, then reload the page.

**Tribal Council:** after giving someone a role, click [[Refresh roles & people]] under your picture or initials (on a phone, in the **☰** menu); it takes effect within a minute.

**I can't find an event.** Check the program year, and make sure [[Planning events]] isn't crossed out under **⚙** (on a phone, both are in the **☰** menu). Click **↻** to refresh, or on a phone, reload the page. Undated ideas sit under **date TBD** (Overview and List) or in the [[Ideas]] column (Calendar).

**It says Saving… for a long time.** A save can take up to half a minute, and the button at the bottom says **Still saving…** when it's slow. Wait for it to turn back into the next step. If [[Save failed — retry]] appears, click it.

**My change didn't stick.** If the open event says [[Save failed — retry]], click it. If a message said a change didn't save after you closed the event, make the change again.

**I can't click Add to Eventbrite or Publish.** Something it needs is missing. The bottom of the event lists what, and the field says **Needed for Eventbrite**; see [What Eventbrite needs](#publish).

**Everything is grayed out.** The event's date has passed (no one can change it), it's cancelled (Tribal Council can reopen it), or you don't have the Program Lead role yet (see above).

**Only Program(s), Leads and Where are grayed out.** Their lists haven't loaded yet: close and reopen the event in a moment, or reload the page.

## Suggest an improvement {#feedback}

Something confusing, or an idea that would help? Tell us.

1. Click [[Feedback / Ideas]] at the top of the page (on a phone, tap **☰** first).
2. Type your idea and click [[Submit]], or click **▲** to add your vote to someone else's.

Each idea shows where it stands: **New**, **Planned**, **Shipped** or **Declined**.

Inside an event, the coming-soon tabs ([[Budget & expenses]], [[Comms]] and [[Feedback]]) have their own idea boards. Tell us what you'd want there.
