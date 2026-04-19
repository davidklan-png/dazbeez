import { promises as fs } from "node:fs";
import path from "node:path";

export type ContactSubmission = {
  firstName: string;
  lastName: string;
  email: string;
  company?: string;
  phoneNumber?: string;
  service?: string;
  message: string;
  submittedAt: string;
  source?: string;
};

const DATA_DIR = process.env.DAZBEEZ_DATA_DIR ?? path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "contact-submissions.jsonl");

export async function appendSubmission(entry: ContactSubmission) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const line = JSON.stringify(entry) + "\n";
  await fs.appendFile(FILE, line, "utf8");
}
