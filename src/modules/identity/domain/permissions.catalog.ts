/**
 * Canonical ProgressEye Permission Catalog
 * Follows the naming convention: <module>.<resource>.<action>
 */

export interface PermissionDefinition {
  code: string;
  module: string;
  description: string;
}

export const PERMISSIONS_CATALOG: PermissionDefinition[] = [
  // --- Platform Module (Reserved exclusively for platform superusers) ---
  {
    code: "platform.school.create",
    module: "platform",
    description: "Provision a new school tenant",
  },
  {
    code: "platform.school.read",
    module: "platform",
    description: "View platform-wide school tenant records",
  },
  {
    code: "platform.school.update",
    module: "platform",
    description: "Update platform-wide school settings",
  },
  {
    code: "platform.plan.manage",
    module: "platform",
    description: "Manage subscription plans and platform feature toggles",
  },
  {
    code: "platform.invite.create",
    module: "platform",
    description: "Create and dispatch principal onboarding invites for tenant schools",
  },

  // --- Tenancy Module ---
  {
    code: "tenancy.school.read",
    module: "tenancy",
    description: "View school tenant profile and settings",
  },
  {
    code: "tenancy.school.update",
    module: "tenancy",
    description: "Update school tenant profile and settings",
  },
  {
    code: "tenancy.invite.create",
    module: "tenancy",
    description: "Issue onboarding invitations for the school",
  },
  {
    code: "tenancy.invite.revoke",
    module: "tenancy",
    description: "Revoke onboarding invitations",
  },

  // --- Identity / Users / Roles Module ---
  {
    code: "identity.user.create",
    module: "identity",
    description: "Create user accounts within the school",
  },
  {
    code: "identity.user.read",
    module: "identity",
    description: "View user profiles and user directory",
  },
  {
    code: "identity.user.update",
    module: "identity",
    description: "Update user profiles within the school",
  },
  {
    code: "identity.user.delete",
    module: "identity",
    description: "Deactivate or delete user accounts",
  },
  {
    code: "identity.role.create",
    module: "identity",
    description: "Create custom roles within the school",
  },
  {
    code: "identity.role.read",
    module: "identity",
    description: "View roles and assigned permissions",
  },
  {
    code: "identity.role.update",
    module: "identity",
    description: "Modify custom roles and permission mappings",
  },
  {
    code: "identity.role.delete",
    module: "identity",
    description: "Delete custom roles within the school",
  },
  {
    code: "identity.role.assign",
    module: "identity",
    description: "Assign or unassign roles to users within the school",
  },
  {
    code: "identity.audit.read",
    module: "identity",
    description: "Inspect tenant audit logs",
  },

  // --- Academic Module ---
  {
    code: "academic.year.manage",
    module: "academic",
    description: "Manage academic years and terms",
  },
  {
    code: "academic.class.read",
    module: "academic",
    description: "View classes, sections, and curriculum",
  },
  {
    code: "academic.class.write",
    module: "academic",
    description: "Create and modify classes and course schedules",
  },

  // --- People Module ---
  {
    code: "people.student.read",
    module: "people",
    description: "View student academic profiles and details",
  },
  {
    code: "people.student.write",
    module: "people",
    description: "Create or modify student records",
  },
  {
    code: "people.staff.read",
    module: "people",
    description: "View staff directory and employment details",
  },
  {
    code: "people.staff.write",
    module: "people",
    description: "Manage staff employment records",
  },

  // --- Attendance Module ---
  {
    code: "attendance.record.read",
    module: "attendance",
    description: "View student and staff attendance records",
  },
  {
    code: "attendance.record.write",
    module: "attendance",
    description: "Mark and update attendance records",
  },

  // --- Assessment / Examination Module ---
  {
    code: "assessment.exam.read",
    module: "assessment",
    description: "View examination schedules and grade boundaries",
  },
  {
    code: "assessment.exam.write",
    module: "assessment",
    description: "Configure exams, timetables, and grading rules",
  },
  {
    code: "assessment.grade.manage",
    module: "assessment",
    description: "Enter, update, and finalize student grades",
  },

  // --- Finance Module ---
  {
    code: "finance.invoice.read",
    module: "finance",
    description: "View fee invoices and billing schedules",
  },
  {
    code: "finance.invoice.create",
    module: "finance",
    description: "Generate student fee invoices",
  },
  {
    code: "finance.payment.record",
    module: "finance",
    description: "Record fee payments and issue receipts",
  },
  {
    code: "finance.report.read",
    module: "finance",
    description: "Access financial and tuition fee ledger reports",
  },

  // --- Communication Module ---
  {
    code: "communication.notice.read",
    module: "communication",
    description: "View school notices, circulars, and messages",
  },
  {
    code: "communication.notice.create",
    module: "communication",
    description: "Publish announcements and broadcast circulars",
  },

  // --- Operations Module (Transport & Hostel) ---
  {
    code: "operations.transport.read",
    module: "operations",
    description: "View bus routes, vehicle details, and stops",
  },
  {
    code: "operations.transport.write",
    module: "operations",
    description: "Configure transportation fleet and route allocations",
  },
  {
    code: "operations.hostel.read",
    module: "operations",
    description: "View dorm rooms, bed allocations, and residential status",
  },
  {
    code: "operations.hostel.write",
    module: "operations",
    description: "Manage hostel room allocations and residence rules",
  },

  // --- Documents Module / Library ---
  {
    code: "documents.record.read",
    module: "documents",
    description: "Access document repository and library catalog",
  },
  {
    code: "documents.record.write",
    module: "documents",
    description: "Upload official certificates, documents, and library books",
  },
];

/**
 * Validates whether a permission code is reserved for platform superusers.
 */
export function isPlatformPermission(code: string): boolean {
  return code.startsWith("platform.");
}

/**
 * Sensitive permissions that mandate two-factor authentication (2FA) enrollment.
 * Derived strictly from canonical PERMISSIONS_CATALOG constants.
 * Any user holding a role containing one or more of these permissions must have 2FA enabled.
 * Covers:
 * - platform_admin (all platform.* permissions)
 * - principal (identity administration, school configuration, financial authority)
 * - accountant (finance invoice creation, financial ledger reporting)
 */
export const SENSITIVE_PERMISSIONS = [
  // Platform administration (platform_admin)
  "platform.school.create",
  "platform.school.read",
  "platform.school.update",
  "platform.plan.manage",
  "platform.invite.create",

  // Identity and RBAC administration (principal)
  "identity.role.create",
  "identity.role.update",
  "identity.role.delete",
  "identity.role.assign",
  "identity.user.create",
  "identity.user.update",
  "identity.user.delete",

  // School tenant administration (principal)
  "tenancy.school.update",
  "tenancy.invite.create",
  "tenancy.invite.revoke",

  // Financial transactions and ledger operations (accountant & principal)
  "finance.invoice.create",
  "finance.report.read",
] as const;

export type SensitivePermissionCode = (typeof SENSITIVE_PERMISSIONS)[number];

/**
 * Evaluates whether a set of permission codes includes any sensitive permission requiring 2FA.
 */
export function requiresTwoFactor(permissions: string[]): boolean {
  const sensitiveSet = new Set<string>(SENSITIVE_PERMISSIONS);
  return permissions.some((code) => sensitiveSet.has(code));
}

/**
 * 13 Built-in System Roles and their Canonical Permission Sets
 */
export interface BuiltInRoleDefinition {
  slug: string;
  name: string;
  description: string;
  permissions: string[];
}

export const SYSTEM_PLATFORM_ROLES: BuiltInRoleDefinition[] = [
  {
    slug: "platform_admin",
    name: "Platform Administrator",
    description: "ProgressEye system administrator with full platform-level privileges",
    permissions: [
      "platform.school.create",
      "platform.school.read",
      "platform.school.update",
      "platform.plan.manage",
      "platform.invite.create",
    ],
  },
];

export const TENANT_BUILT_IN_ROLES: BuiltInRoleDefinition[] = [
  {
    slug: "principal",
    name: "Principal",
    description: "Chief executive administrator with full privileges across all tenant modules",
    permissions: [
      "tenancy.school.read",
      "tenancy.school.update",
      "tenancy.invite.create",
      "tenancy.invite.revoke",
      "identity.user.create",
      "identity.user.read",
      "identity.user.update",
      "identity.user.delete",
      "identity.role.create",
      "identity.role.read",
      "identity.role.update",
      "identity.role.delete",
      "identity.role.assign",
      "identity.audit.read",
      "academic.year.manage",
      "academic.class.read",
      "academic.class.write",
      "people.student.read",
      "people.student.write",
      "people.staff.read",
      "people.staff.write",
      "attendance.record.read",
      "attendance.record.write",
      "assessment.exam.read",
      "assessment.exam.write",
      "assessment.grade.manage",
      "finance.invoice.read",
      "finance.invoice.create",
      "finance.payment.record",
      "finance.report.read",
      "communication.notice.read",
      "communication.notice.create",
      "operations.transport.read",
      "operations.transport.write",
      "operations.hostel.read",
      "operations.hostel.write",
      "documents.record.read",
      "documents.record.write",
    ],
  },
  {
    slug: "teacher",
    name: "Teacher",
    description: "Academic educator with class attendance and grading authority",
    permissions: [
      "academic.class.read",
      "people.student.read",
      "attendance.record.read",
      "attendance.record.write",
      "assessment.exam.read",
      "assessment.grade.manage",
      "communication.notice.read",
      "documents.record.read",
    ],
  },
  {
    slug: "student",
    name: "Student",
    description:
      "Student with read-only access to own academic records, attendance, and fee invoices",
    permissions: [
      "academic.class.read",
      "people.student.read",
      "attendance.record.read",
      "assessment.exam.read",
      "finance.invoice.read",
      "communication.notice.read",
      "documents.record.read",
    ],
  },
  {
    slug: "parent",
    name: "Parent",
    description: "Guardian with access to linked children's attendance, grades, and fee settlement",
    permissions: [
      "people.student.read",
      "attendance.record.read",
      "assessment.exam.read",
      "finance.invoice.read",
      "finance.payment.record",
      "communication.notice.read",
      "documents.record.read",
    ],
  },
  {
    slug: "accountant",
    name: "Accountant",
    description:
      "Finance administrator managing student fees, billing, payments, and financial reports",
    permissions: [
      "finance.invoice.read",
      "finance.invoice.create",
      "finance.payment.record",
      "finance.report.read",
      "people.student.read",
      "people.staff.read",
      "communication.notice.read",
    ],
  },
  {
    slug: "librarian",
    name: "Librarian",
    description: "Library custodian managing document repository and library book circulation",
    permissions: [
      "documents.record.read",
      "documents.record.write",
      "people.student.read",
      "people.staff.read",
      "communication.notice.read",
    ],
  },
  {
    slug: "receptionist",
    name: "Receptionist",
    description:
      "Front-desk administrative assistant handling visitor intake and student directory lookup",
    permissions: [
      "people.student.read",
      "people.staff.read",
      "communication.notice.read",
      "documents.record.read",
    ],
  },
  {
    slug: "exam_coordinator",
    name: "Examination Coordinator",
    description:
      "Officer responsible for scheduling examinations, hall tickets, and final grade publishing",
    permissions: [
      "assessment.exam.read",
      "assessment.exam.write",
      "assessment.grade.manage",
      "academic.class.read",
      "people.student.read",
      "communication.notice.read",
    ],
  },
  {
    slug: "transport_manager",
    name: "Transport Manager",
    description: "Operations officer managing school buses, vehicle routes, and transit stops",
    permissions: [
      "operations.transport.read",
      "operations.transport.write",
      "people.student.read",
      "people.staff.read",
      "communication.notice.read",
    ],
  },
  {
    slug: "hostel_warden",
    name: "Hostel Warden",
    description:
      "Residential supervisor managing dormitories, room allocations, and student boarders",
    permissions: [
      "operations.hostel.read",
      "operations.hostel.write",
      "people.student.read",
      "attendance.record.read",
      "attendance.record.write",
      "communication.notice.read",
    ],
  },
  {
    slug: "nurse",
    name: "School Nurse",
    description:
      "Medical caregiver managing student health logs, allergy alerts, and infirmary visits",
    permissions: ["people.student.read", "people.staff.read", "communication.notice.read"],
  },
  {
    slug: "counselor",
    name: "School Counselor",
    description:
      "Student wellbeing counselor with access to confidential counseling and observation notes",
    permissions: ["people.student.read", "people.staff.read", "communication.notice.read"],
  },
];

export const BUILT_IN_ROLES: BuiltInRoleDefinition[] = [
  ...SYSTEM_PLATFORM_ROLES,
  ...TENANT_BUILT_IN_ROLES,
];
