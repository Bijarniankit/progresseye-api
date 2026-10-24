import pino from "pino";

describe("Pino Logging Redaction & Zero PII Leakage", () => {
  const redactPaths = [
    "req.headers.authorization",
    "req.headers.cookie",
    "body.password",
    "body.token",
    "body.secret",
    "body.apiKey",
    "body.email",
    "body.name",
    "body.schoolName",
    "body.message",
    "body.notes",
    "body.turnstileToken",
    "body.website_url",
    "body.topic",
  ];

  it("redacts sensitive body fields, headers, and turnstile tokens across public requests", () => {
    let capturedLog = "";
    const logger = pino(
      {
        redact: redactPaths,
      },
      {
        write: (str: string) => {
          capturedLog += str;
        },
      },
    );

    const sensitiveContactPayload = {
      req: {
        method: "POST",
        url: "/api/v1/public/contact",
        headers: {
          authorization: "Bearer secret-token-xyz",
          cookie: "session=sensitive-session-cookie",
        },
      },
      body: {
        name: "Principal Aditi Roy",
        email: "aditi.roy@heritage-school.edu.in",
        schoolName: "Heritage Public School",
        message: "Confidential inquiry regarding institutional student records and fee schedules",
        notes: "Internal staff notes should never be logged",
        turnstileToken: "cf-turnstile-token-secret-12345",
        topic: "Fee Engine",
        website_url: "honeypot-url",
      },
    };

    logger.info(sensitiveContactPayload, "Public contact request received");

    // Assert that NONE of the raw PII strings appear in the serialized log output
    expect(capturedLog).not.toContain("Principal Aditi Roy");
    expect(capturedLog).not.toContain("aditi.roy@heritage-school.edu.in");
    expect(capturedLog).not.toContain("Heritage Public School");
    expect(capturedLog).not.toContain("Confidential inquiry regarding institutional");
    expect(capturedLog).not.toContain("Internal staff notes should never be logged");
    expect(capturedLog).not.toContain("cf-turnstile-token-secret-12345");
    expect(capturedLog).not.toContain("Bearer secret-token-xyz");
    expect(capturedLog).not.toContain("sensitive-session-cookie");

    // Assert redacted placeholder is present
    expect(capturedLog).toContain("[Redacted]");
  });

  it("redacts newsletter email submissions", () => {
    let capturedLog = "";
    const logger = pino(
      { redact: redactPaths },
      {
        write: (str: string) => {
          capturedLog += str;
        },
      },
    );

    logger.info(
      {
        body: {
          email: "subscriber.personal@gmail.com",
          turnstileToken: "token-9999",
        },
      },
      "Newsletter subscription received",
    );

    expect(capturedLog).not.toContain("subscriber.personal@gmail.com");
    expect(capturedLog).not.toContain("token-9999");
    expect(capturedLog).toContain("[Redacted]");
  });
});
