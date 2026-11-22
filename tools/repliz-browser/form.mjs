export const scheduleUrl = 'https://repliz.com/user/schedule';
export const loginUrl = 'https://repliz.com/login';

export class ReplizLoginRequired extends Error {}

const isSchedule = (url) => url.origin === 'https://repliz.com' && url.pathname === '/user/schedule';
const waitForUser = 5 * 60_000;

export async function prepareReplizForm(page, path, title) {
  await page.goto(scheduleUrl, { waitUntil: 'domcontentloaded' });
  const newSchedule = page.getByRole('button', { name: /^(new schedule|jadwal baru)$/i });
  const signedOut = await Promise.race([
    newSchedule.waitFor().then(() => false),
    page.waitForURL(loginUrl).then(() => true),
  ]);
  if (signedOut) throw new ReplizLoginRequired();
  if (!isSchedule(new URL(page.url()))) throw new Error('The Repliz calendar is no longer open.');
  await newSchedule.click();
  await page.getByRole('dialog').getByText(/^(create schedule|buat konten)$/i).click();
  const video = page.getByRole('radio', { name: 'Video', exact: true });
  const form = page.getByRole('dialog').filter({ has: video });
  await video.click();
  const caption = form.getByPlaceholder(/^(enter description|masukan deskripsi)$/i);
  const captionLimit = Number(await caption.getAttribute('maxlength'));
  await caption.fill(captionLimit > 0 ? title.slice(0, captionLimit) : title);
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 15_000 }),
    form.getByText(/^(upload|unggah)$/i).click(),
  ]);
  if (!isSchedule(new URL(page.url()))) throw new Error('The Repliz calendar is no longer open.');
  await chooser.setFiles(path);
  await form.getByRole('button', { name: /^(delete|hapus)$/i }).waitFor();

  await form.getByRole('button', { name: /^(account|akun)$/i }).click();
  const now = form.getByRole('button', { name: /^(now|sekarang)$/i });
  await now.waitFor({ timeout: waitForUser });
  const titleField = form.getByPlaceholder(/^(enter title|masukan judul)$/i);
  if (await titleField.isVisible()) await titleField.fill(title.slice(0, 100));
  await now.click();
}
