import { Injectable, Logger } from "@nestjs/common";
import * as nodemailer from "nodemailer";
import { AppConfigService } from "../../../../config/config.service";

export interface SendEmailOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface IEmailDeliveryService {
  sendEmail(options: SendEmailOptions): Promise<void>;
}

export const EMAIL_DELIVERY_SERVICE = Symbol("EMAIL_DELIVERY_SERVICE");

@Injectable()
export class SmtpEmailDeliveryService implements IEmailDeliveryService {
  private readonly logger = new Logger(SmtpEmailDeliveryService.name);
  private transporter: nodemailer.Transporter | null = null;

  constructor(private readonly config: AppConfigService) {
    this.initTransporter();
  }

  private initTransporter(): void {
    const host = this.config.get("SMTP_HOST") || "localhost";
    const port = Number(this.config.get("SMTP_PORT") || 1025);
    const user = this.config.get("SMTP_USER");
    const pass = this.config.get("SMTP_PASS");

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: user && pass ? { user, pass } : undefined,
    });
  }

  async sendEmail(options: SendEmailOptions): Promise<void> {
    const from = this.config.get("MAIL_FROM") || "noreply@progresseye.com";

    if (!this.transporter) {
      this.initTransporter();
    }

    try {
      await this.transporter?.sendMail({
        from,
        to: options.to,
        subject: options.subject,
        text: options.text,
        html: options.html,
      });

      this.logger.log({
        event: "email_dispatched",
        subject: options.subject, // PII-free subject line
      });
    } catch (err) {
      this.logger.error({
        event: "email_dispatch_failed",
        error: (err as Error).message,
        subject: options.subject,
      });
      throw err;
    }
  }
}
