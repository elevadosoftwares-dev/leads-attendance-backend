import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config/env';
import { logger } from '../utils/logger';

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (!env.SMTP_HOST) return null;
  transporter ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
  return transporter;
}

export const mailService = {
  /** Sends the reset link, or logs it to the console when SMTP isn't configured. */
  async sendPasswordReset(to: string, name: string, link: string): Promise<void> {
    const transport = getTransporter();
    if (!transport) {
      logger.info({ to, link }, 'SMTP not configured; password reset link');
      return;
    }
    await transport.sendMail({
      from: env.MAIL_FROM,
      to,
      subject: 'Reset your LEADS Attendance password',
      text:
        `Hi ${name},\n\nWe received a request to reset your LEADS Attendance password.\n` +
        `Use this link within 1 hour:\n\n${link}\n\n` +
        `If you didn't ask for this, you can ignore this email.\n`,
    });
  },
};
