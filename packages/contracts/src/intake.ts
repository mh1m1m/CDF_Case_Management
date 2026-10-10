/**
 * Public-portal intake enums aligned with the Drive whistleblowing requirements report (CDF-63).
 * The database (migration 1500) is authoritative; these lists mirror it.
 */

/** Drive field 3. */
export const REPORTER_MODES = ["ANONYMOUS", "EMAIL_ONLY", "IDENTIFIED"] as const;
export type ReporterMode = (typeof REPORTER_MODES)[number];

/** Drive field 1. */
export const RELATIONSHIPS_TO_FUND = [
  "BENEFICIARY",
  "APPLICANT",
  "SUPPLIER",
  "CONTRACTOR",
  "THIRD_PARTY",
  "EMPLOYEE",
  "OTHER",
] as const;
export type RelationshipToFund = (typeof RELATIONSHIPS_TO_FUND)[number];

/** Drive field 5. */
export const GENDERS = ["MALE", "FEMALE"] as const;

/** Drive field 6: the calendar the reporter entered the date of birth in. */
export const BIRTH_DATE_CALENDARS = ["GREGORIAN", "HIJRI"] as const;

/** Drive field 7. */
export const ID_TYPES = ["NATIONAL_ID", "IQAMA", "PASSPORT"] as const;
export type IdType = (typeof ID_TYPES)[number];

/**
 * Drive field 9 ("the approved list"). PRODUCTION_SUBSTITUTION_REQUIRED: replace with CDF's
 * approved city reference list.
 */
export const CITIES = [
  "RIYADH",
  "JEDDAH",
  "MAKKAH",
  "MADINAH",
  "DAMMAM",
  "KHOBAR",
  "DHAHRAN",
  "AL_AHSA",
  "JUBAIL",
  "TAIF",
  "TABUK",
  "ABHA",
  "KHAMIS_MUSHAIT",
  "BURAIDAH",
  "HAIL",
  "JAZAN",
  "NAJRAN",
  "AL_BAHA",
  "ARAR",
  "SAKAKA",
  "YANBU",
  "OTHER",
] as const;

/**
 * Drive field 10. ISO 3166-1 alpha-2 codes; display names come from Intl.DisplayNames.
 * PRODUCTION_SUBSTITUTION_REQUIRED: CDF's approved nationality reference list.
 */
export const NATIONALITIES = (
  "SA AE BH KW OM QA YE EG JO LB SY IQ PS SD LY TN DZ MA MR SO DJ KM " +
  "AF AL AR AM AU AT AZ BD BY BE BJ BT BO BA BW BR BN BG BF BI KH CM CA CV CF TD CL CN CO CG CD CR CI HR CU CY CZ " +
  "DK DM DO EC SV GQ ER EE SZ ET FJ FI FR GA GM GE DE GH GR GD GT GN GW GY HT HN HU IS IN ID IR IE IT JM JP KZ KE " +
  "KI KP KR KG LA LV LS LR LI LT LU MG MW MY MV ML MT MH MU MX FM MD MC MN ME MZ MM NA NR NP NL NZ NI NE NG MK NO " +
  "PK PW PA PG PY PE PH PL PT RO RU RW KN LC VC WS SM ST SN RS SC SL SG SK SI SB ZA SS ES LK SR SE CH TJ TZ TH TL " +
  "TG TO TT TR TM TV UG UA GB US UY UZ VU VE VN ZM ZW"
).split(" ");

// ---- Reporter attachments (Drive field 19; CDF-72, ADR-015) -----------------------------------
/** Per file. Keeps one upload request under the hosting request-body limit. Mirrors migration 1600. */
export const REPORTER_ATTACHMENT_MAX_BYTES = 4_194_304;
/** Live (non-rejected) files per report. */
export const REPORTER_ATTACHMENT_MAX_FILES = 10;
/** Live bytes per report. */
export const REPORTER_ATTACHMENT_MAX_TOTAL_BYTES = 20_971_520;

export const ATTACHMENT_SOURCES = ["REPORT", "FOLLOW_UP"] as const;
export type AttachmentSource = (typeof ATTACHMENT_SOURCES)[number];

export type ReportAttachmentStatus = "QUARANTINED" | "AVAILABLE" | "REJECTED";

/** What intake and case teams see. No file name is ever stored; the display name is generated. */
export interface ReportAttachmentItem {
  id: string;
  sequenceNo: number;
  displayName: string;
  source: AttachmentSource;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  status: ReportAttachmentStatus;
  receivedAt: string;
}

/** ATT-001.pdf: the only name an attachment has inside the platform. */
export function attachmentDisplayName(sequenceNo: number, extension: string): string {
  return `ATT-${String(sequenceNo).padStart(3, "0")}.${extension}`;
}
