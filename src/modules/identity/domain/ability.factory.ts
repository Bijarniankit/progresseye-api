import { AbilityBuilder, createMongoAbility, type MongoAbility } from "@casl/ability";
import { Injectable } from "@nestjs/common";

export type AppAbility = MongoAbility;

export interface UserSecurityContext {
  userId: string;
  schoolId: string;
  permissions: string[];
  roles?: string[];
  attributes?: {
    assignedSections?: string[];
    linkedChildren?: string[];
  };
}

@Injectable()
export class AbilityFactory {
  /**
   * Constructs an executable CASL AppAbility based on the user's effective permissions and context.
   */
  createForUser(context: UserSecurityContext): AppAbility {
    const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);

    const permissions = new Set(context.permissions || []);

    // Loop through all permissions held by the user and register CASL rules
    for (const code of permissions) {
      // Register direct code ability (e.g. can("execute", "identity.role.create"))
      can(code, "all");

      // Canonical 3-part decomposition: <module>.<resource>.<action>
      const parts = code.split(".");
      if (parts.length >= 3) {
        const action = parts[parts.length - 1] as string; // e.g. "read", "create", "update", "delete", "manage"
        const resource = parts.slice(0, -1).join("."); // e.g. "identity.role", "people.student"

        if (action === "manage") {
          can("manage", resource);
        } else {
          can(action, resource);
        }

        // Forward compatibility / attribute stubs for Phases 15 & 16:
        // Teacher section-level scoping:
        if (resource === "attendance.record" && context.attributes?.assignedSections?.length) {
          can(action, resource, {
            sectionId: { $in: context.attributes.assignedSections },
          });
        }

        // Parent child-level scoping:
        if (resource === "people.student" && context.attributes?.linkedChildren?.length) {
          can(action, resource, {
            studentId: { $in: context.attributes.linkedChildren },
          });
        }

        // Student self-only scoping:
        if (context.roles?.includes("student")) {
          can(action, "people.student", {
            userId: context.userId,
          });
        }
      }
    }

    return build();
  }
}
