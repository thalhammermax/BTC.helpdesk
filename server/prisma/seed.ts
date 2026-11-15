/** Seeds starter categories, teams, auto-assignment rules and canned responses. Safe to re-run. */
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const cats = ['Hardware', 'Software', 'Network', 'Accounts & Access', 'Email', 'Printing', 'Other'];
  for (const name of cats) await prisma.category.upsert({ where: { name }, update: {}, create: { name } });
  const cat = async (name: string) => (await prisma.category.findUnique({ where: { name } }))!.id;

  const teams = [
    { name: 'Service Desk', description: 'First-line support (default queue)', strategy: 'LEAST_LOADED' as const },
    { name: 'Network', description: 'VPN, Wi-Fi, firewall', strategy: 'ROUND_ROBIN' as const },
    { name: 'Identity & Access', description: 'Accounts, passwords, MFA, permissions', strategy: 'ROUND_ROBIN' as const },
    { name: 'Hardware', description: 'Laptops, monitors, peripherals, printers', strategy: 'LEAST_LOADED' as const },
  ];
  for (const t of teams) await prisma.team.upsert({ where: { name: t.name }, update: {}, create: t });
  const team = async (name: string) => (await prisma.team.findUnique({ where: { name } }))!.id;

  if ((await prisma.assignmentRule.count()) === 0) {
    const rules = [
      { name: 'Urgent wording → Urgent priority', keywords: ['urgent', 'asap', 'emergency', 'outage', '"system down"'], setPriority: 'URGENT' as const, addTags: ['escalated'], stopProcessing: false },
      { name: 'Network issues', keywords: ['vpn', 'wifi', 'wi-fi', 'wireless', 'network', 'internet', 'firewall', 'dns'], assignTeamId: await team('Network'), setCategoryId: await cat('Network') },
      { name: 'Accounts & passwords', keywords: ['password', 'locked out', 'mfa', 'authenticator', 'login', 'sign in', 'permission*', 'access'], assignTeamId: await team('Identity & Access'), setCategoryId: await cat('Accounts & Access') },
      { name: 'Printing', keywords: ['print*', 'toner', 'scanner'], assignTeamId: await team('Hardware'), setCategoryId: await cat('Printing') },
      { name: 'Hardware', keywords: ['laptop', 'monitor', 'keyboard', 'mouse', 'dock*', 'headset', 'battery'], assignTeamId: await team('Hardware'), setCategoryId: await cat('Hardware') },
    ];
    for (const [position, r] of rules.entries()) await prisma.assignmentRule.create({ data: { ...r, position } });
  }
  await prisma.setting.upsert({ where: { key: 'defaultTeamId' }, update: {}, create: { key: 'defaultTeamId', value: await team('Service Desk') } });

  if ((await prisma.cannedResponse.count()) === 0) {
    await prisma.cannedResponse.createMany({
      data: [
        { title: 'Restart first', body: 'Hi,\n\nCould you please restart your device and let us know if the issue persists?\n\nThanks!' },
        { title: 'Need more info', body: 'Hi,\n\nThanks for reaching out. Could you send us a screenshot of the error and the time it happened?\n\nThanks!' },
        { title: 'Resolved – confirm', body: "Hi,\n\nWe believe this is now fixed. If anything is still wrong just reply to this email and we'll reopen the ticket." },
      ],
    });
  }
  console.log('Seed complete');
}
main().finally(() => prisma.$disconnect());
