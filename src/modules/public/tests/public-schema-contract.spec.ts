import {
  ContactLeadDto,
  ContactLeadSchema,
  DemoLeadDto,
  DemoLeadSchema,
  NewsletterLeadDto,
  NewsletterLeadSchema,
} from "../dto";

describe("Public Schemas & OpenAPI Contract Parity", () => {
  it("generates OpenAPI metadata matching ContactLeadSchema properties exactly", () => {
    // biome-ignore lint/suspicious/noExplicitAny: inspecting private factory method
    const metadata = (ContactLeadDto as any)._OPENAPI_METADATA_FACTORY();
    expect(metadata).toBeDefined();

    const openApiKeys = Object.keys(metadata);
    const zodShapeKeys = Object.keys(ContactLeadSchema.shape);

    // Assert every Zod schema field exists in the OpenAPI metadata
    for (const key of zodShapeKeys) {
      expect(openApiKeys).toContain(key);
    }

    // Verify required fields
    expect(metadata.name.required).toBe(true);
    expect(metadata.email.required).toBe(true);
    expect(metadata.message.required).toBe(true);
    expect(metadata.consentGiven.required).toBe(true);
    // Optional fields
    expect(metadata.schoolName.required).toBeFalsy();
    expect(metadata.topic.required).toBeFalsy();
    expect(metadata.turnstileToken.required).toBeFalsy();
    expect(metadata.website_url.required).toBeFalsy();
  });

  it("generates OpenAPI metadata matching DemoLeadSchema properties exactly", () => {
    // biome-ignore lint/suspicious/noExplicitAny: inspecting private factory method
    const metadata = (DemoLeadDto as any)._OPENAPI_METADATA_FACTORY();
    expect(metadata).toBeDefined();

    const openApiKeys = Object.keys(metadata);
    const zodShapeKeys = Object.keys(DemoLeadSchema.shape);

    for (const key of zodShapeKeys) {
      expect(openApiKeys).toContain(key);
    }

    expect(metadata.name.required).toBe(true);
    expect(metadata.email.required).toBe(true);
    expect(metadata.schoolName.required).toBe(true);
    expect(metadata.consentGiven.required).toBe(true);
    expect(metadata.notes.required).toBeFalsy();
  });

  it("generates OpenAPI metadata matching NewsletterLeadSchema properties exactly", () => {
    // biome-ignore lint/suspicious/noExplicitAny: inspecting private factory method
    const metadata = (NewsletterLeadDto as any)._OPENAPI_METADATA_FACTORY();
    expect(metadata).toBeDefined();

    const openApiKeys = Object.keys(metadata);
    const zodShapeKeys = Object.keys(NewsletterLeadSchema.shape);

    for (const key of zodShapeKeys) {
      expect(openApiKeys).toContain(key);
    }

    expect(metadata.email.required).toBe(true);
    expect(metadata.consentGiven.required).toBe(true);
  });
});
