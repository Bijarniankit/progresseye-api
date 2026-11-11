import { AbilityFactory } from "./ability.factory";

describe("AbilityFactory", () => {
  let factory: AbilityFactory;

  beforeEach(() => {
    factory = new AbilityFactory();
  });

  it("should grant access for exact permission code", () => {
    const ability = factory.createForUser({
      userId: "user-1",
      schoolId: "school-1",
      permissions: ["identity.role.create", "identity.role.read"],
    });

    expect(ability.can("create", "identity.role")).toBe(true);
    expect(ability.can("read", "identity.role")).toBe(true);
    expect(ability.can("delete", "identity.role")).toBe(false);
  });

  it("should handle manage action as wildcard for the resource", () => {
    const ability = factory.createForUser({
      userId: "user-1",
      schoolId: "school-1",
      permissions: ["academic.year.manage"],
    });

    expect(ability.can("manage", "academic.year")).toBe(true);
    expect(ability.can("update", "academic.year")).toBe(true);
    expect(ability.can("delete", "academic.year")).toBe(true);
  });

  it("should evaluate teacher section attribute conditions (stubs)", () => {
    const ability = factory.createForUser({
      userId: "teacher-1",
      schoolId: "school-1",
      permissions: ["attendance.record.write"],
      roles: ["teacher"],
      attributes: {
        assignedSections: ["sec-A", "sec-B"],
      },
    });

    // Directly matches section in assignedSections
    expect(ability.can("write", "attendance.record")).toBe(true);
  });

  it("should evaluate parent linked children attribute conditions (stubs)", () => {
    const ability = factory.createForUser({
      userId: "parent-1",
      schoolId: "school-1",
      permissions: ["people.student.read"],
      roles: ["parent"],
      attributes: {
        linkedChildren: ["child-1", "child-2"],
      },
    });

    expect(ability.can("read", "people.student")).toBe(true);
  });

  it("should evaluate student self-only scoping condition (stubs)", () => {
    const ability = factory.createForUser({
      userId: "student-1",
      schoolId: "school-1",
      permissions: ["people.student.read"],
      roles: ["student"],
    });

    expect(ability.can("read", "people.student")).toBe(true);
  });
});
