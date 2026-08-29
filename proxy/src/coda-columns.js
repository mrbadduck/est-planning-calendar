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
  published:         'c-My7LREwSH9', // Published?
  status:            'c-ioK48RRF3x', // Status
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
};
