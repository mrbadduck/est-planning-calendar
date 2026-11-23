// Coda column IDs — the STABLE handle for every column we read/write. Column
// *names* change freely in the Coda doc; ids don't (a rename keeps the id; only
// deleting and recreating a column mints a new one). Reference columns by these
// ids everywhere — read rows with useColumnNames=false so values are keyed by id,
// and write cells with { column: <id> } — so renames never break the Worker.
// Each id is commented with its current human name for readability.

export const PLANNING_COLS = {
  title:             'c-NV09i0HwXb', // Title
  scheduling:        'c-7M5lD7tMdc', // Scheduling
  date:              'c-TOKaRG28oJ', // Date
  start:             'c-MSm0b33TYA', // Start
  end:               'c-89OL6HGJWW', // End
  allDay:            'c-BCgUbuY54M', // All day
  windowStart:       'c-4oAGclVRPK', // Window start
  windowEnd:         'c-2rn_MZK5ul', // Window end
  publicSummary:     'c-z_vizJhFiU', // Public summary
  publicDescription: 'c-FPf9UlI_8n', // Public description
  venue:             'c-UbJKs7XRGP', // Venue
  venueOther:        'c-OyQtpm8VhZ', // Venue (other)
  addressVisibility: 'c-TrnSY-vnb4', // Address visibility
  eventbriteUrl:     'c-3AYH04FRwQ', // Eventbrite URL
  eventbriteId:      'c-BgcuPz_B7_', // Eventbrite Event ID
  lastEbPushAt:      'c-dnQgyLVxPo', // Last EB push at (Worker-written; publish conflict guard)
  lastEbPushedValues: 'c-nmm4LZ79JO', // Last EB pushed values (JSON snapshot of what the Worker last sent to Eventbrite)
  published:         'c-My7LREwSH9', // Published?
  status:            'c-ioK48RRF3x', // Status
  capacity:          'c-FtIEIv1oNF', // Capacity
  publishStatus:     'c-Bppgu3CtFt', // Publish status
  ticketClassId:     'c-_FdJ_-XX0_', // Eventbrite Ticket Class ID
  lastPublishedAt:   'c-VQaRCCKLzX', // Last published at
  lastPublishError:  'c-rIhvH9m_Y5', // Last publish error
  eventDescription:  'c-ZJO5Ge_PyI', // Event Description
  programs:          'c-tHwtj89ksi', // Program(s)
  source:            'c-XNXXPfY74v', // Source (select: Plan / Eventbrite / Backfill; default Plan)
  lastFromEb:        'c-b02zbLiHgk', // Last from Eventbrite (Worker-written JSON {at, fields})
  leads:             'c-92mRz-1SYp', // Leads
  volunteers:        'c-8_uS1RK9Qx', // Volunteers
  legacyRow:         'c-sUpvHhlGlI', // Linked EST Events SRC row (to be renamed "Legacy EST Events row")
  createdBy:         'c-ueS3RrH9ie', // Created by
  gcalEventId:       'c-4eceDYOmPM', // gCal Event ID (Worker-written: the Google Calendar event this row put on the calendar)
};

// EST Events SRC, the legacy events table the one-table backfill reads.
export const LEGACY_EVENTS_TABLE = 'grid-9TAt5vMMKH';

export const LEGACY_COLS = {
  name:                    'c-YcC1vx5Ung', // Event Name
  eventbriteEvent:         'c-LvlbW7Fk28', // Eventbrite Event
  venue:                   'c-qnAUWGhhWe', // Venue
  collaborators:           'c-v8SaE7WTNb', // Collaborators
  cancelled:               'c-kZqi1huBiz', // Cancelled?
  date:                    'c-FNeOszspAw', // Event Date (for Metrics)
  volunteers:              'c-K8QqK9dNsv', // Volunteers
  leads:                   'c-Gp18FBaE8q', // Leads
  attendeesOverride:       'c-LHDV30AIeI', // Num Attendees (Manual Override)
  eventbriteId:            'c-sLsqeZ0_zh', // Eventbrite Id
  gcalEventId:             'c-qFF9aveinM', // gCal Event Id
  bannerOverride:          'c--RGP1jqmMp', // Banner Image Override
  registrationUrlOverride: 'c-2-8FNMkNKQ', // Registration URL Override
  programs:                'c-43WF5l9MHf', // Program(s)
  start:                   'c-Dx4hZN7o83', // Event Start
  end:                     'c-0pwRaIBqeA', // Event End
  eventDescription:        'c-veXmap6hVO', // Event Description
  photos:                  'c-diN53OflnB', // Event Photos
};

export const SLOT_COLS = {
  label:     'c-HGZoDPybU0', // Label
  event:     'c-0eINgAfHAY', // Event
  kind:      'c-CwTx67BE8c', // Kind
  neededQty: 'c-2dIFNdIv0g', // Needed qty
  sortOrder: 'c-NMi8IPDd16', // Sort order
};

export const CLAIM_COLS = {
  contributionDetail: 'c-pakWc90BFi', // Contribution detail
  slot:               'c-_vjs90aphQ', // Slot
  member:             'c-Zwqd0c3-t7', // Member
  qty:                'c-Y4oHns4wvj', // Qty
  notes:              'c-csWyWkcybu', // Notes
};

export const PEOPLE_COLS = {
  fullName:         'c-3p5JGplowl', // Full Name
  firstName:        'c-1kD4tvffSw', // First Name
  lastName:         'c-tNUdtz60UJ', // Last Name
  emailManual:      'c-W8Jp4RvWQj', // Email (Manual Input)
  allEmails:        'c-6HV3jKCecV', // All Emails (read-only formula)
  leadershipStatus: 'c-STedpK20lj', // Leadership Status
  notes:            'c-5arbru61lv', // Notes
  activeMember:     'c-yJfWc0GMsQ', // Active Member? (formula: any active Givebutter plan — Coda owns the rule)
};

// EST Venues SRC (grid-foC40iAOaX). Street..ZIP are the structured address (venues
// plan); Address stays as the composed one-line form, kept in step on every write.
export const VENUE_COLS = {
  name:             'c-qOEGjzi8TZ', // Venue Name
  address:          'c-19lFeKZu_W', // Address (plain text column, no formula; the app/Worker write it composed as "Street, Unit, City, ST ZIP")
  type:             'c-Yqz2FaSKTR', // Venue Type (lookup → Venue Types, grid-idEVRQX7SL)
  ebVenueId:        'c-8q1sI7FT2R', // Eventbrite Venue ID (public EB venue, Worker cache)
  ebPrivateVenueId: 'c-KPZs1NHQFF', // Eventbrite Private Venue ID (registrants-only EB venue, Worker cache)
  closed:           'c-ZWCo5eGocY', // Closed/Unavailable?
  street:           'c-DVGodIB9ff', // Street
  unit:             'c-I_Mey38jb9', // Unit
  city:             'c-PDWYIzqJtG', // City
  state:            'c-nJ_J6R0IFM', // State
  zip:              'c-TEQbfD91Y5', // ZIP
};
