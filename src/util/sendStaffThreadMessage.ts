import { EmbedBuilder, bold, inlineCode } from '@discordjs/builders';
import { PrismaClient } from '@prisma/client';
import {
	Attachment,
	Colors,
	GuildMember,
	ChatInputCommandInteraction,
	MessageEditOptions,
	MessageOptions,
	ThreadChannel,
	Message,
	MessageContextMenuCommandInteraction,
} from 'discord.js';
import i18next from 'i18next';
import { container } from 'tsyringe';

export interface SendStaffThreadMessageOptions {
	content: string;
	attachment?: Attachment | null;
	staff: GuildMember;
	member: GuildMember;
	channel: ThreadChannel;
	threadId: number;
	simpleMode: boolean;
	anon: boolean;
	interaction?: ChatInputCommandInteraction<'cached'> | MessageContextMenuCommandInteraction<'cached'>;
	existing?: { user: Message; guild: Message; replyId: number };
}

export async function sendStaffThreadMessage({
	content,
	attachment,
	staff,
	member,
	channel,
	threadId,
	simpleMode,
	anon,
	interaction,
	existing,
}: SendStaffThreadMessageOptions) {
	const prisma = container.resolve(PrismaClient);

	const options: Omit<MessageOptions, 'flags'> = {};
	if (simpleMode) {
		options.content = `${bold(
			`${existing ? `${inlineCode(existing.replyId.toString())} ` : ''}${anon ? '(Anonymous) ' : ''}(${
				staff.guild.name
			} Team) ${staff.user.tag}:`,
		)} ${content}`;
		if (attachment) {
			options.files = [attachment];
		} else {
			options.files = [];
			options.attachments = [];
		}
	} else {
		const embed = new EmbedBuilder()
			.setColor(Colors.Blurple)
			.setDescription(content)
			.setImage(attachment?.url ?? null)
			.setFooter({
				text: `${existing ? `Reply ID: ${existing.replyId} | ` : ''}${staff.user.tag} (${staff.user.id})`,
				iconURL: staff.user.displayAvatarURL(),
			});

		if (anon) {
			embed.setAuthor({ name: `${staff.guild.name} Team`, iconURL: staff.guild.iconURL() ?? undefined });
		} else {
			embed.setAuthor({ name: staff.displayName, iconURL: staff.displayAvatarURL() });
		}

		options.embeds = [embed];
	}

	const userOptions = { ...options };
	// Now that we've sent the message locally, we can purge all identifying information from anon messages
	if (anon) {
		if (simpleMode) {
			userOptions.content = `${bold(`${staff.guild.name} Team:`)} ${content}`;
		} else {
			const [embed] = userOptions.embeds as [EmbedBuilder];
			embed.setFooter(null);
			userOptions.embeds = [embed];
		}
	}

	if (existing) {
		await interaction?.reply({ content: 'Successfully edited your message' });
		setTimeout(() => void interaction?.deleteReply().catch(() => null), 1000);
		await existing.guild.edit(options);
		return existing.user.edit(userOptions);
	}

	const guildMessage = await channel.send(options);
	await interaction?.reply({ content: 'Successfully posted your message' });
	setTimeout(() => void interaction?.deleteReply().catch(() => null), 1000);

	let userMessage: Message;
	try {
		userMessage = await member.send(userOptions);
	} catch {
		return channel.send(i18next.t('common.errors.dm_fail'));
	}

	const threadMessage = await prisma.$transaction(async (prisma) => {
		const { lastLocalThreadMessageId: localThreadMessageId } = await prisma.thread.update({
			data: {
				lastLocalThreadMessageId: { increment: 1 },
			},
			where: { threadId },
		});

		return prisma.threadMessage.create({
			data: {
				guildId: member.guild.id,
				localThreadMessageId,
				threadId,
				userId: member.user.id,
				userMessageId: userMessage.id,
				guildMessageId: guildMessage.id,
				staffId: staff.user.id,
				anon,
			},
		});
	});

	// Edit the reply ID in
	if (simpleMode) {
		options.content = `${inlineCode(threadMessage.localThreadMessageId.toString())} ${options.content!}`;
	} else {
		const [embed] = options.embeds as [EmbedBuilder];
		embed.setFooter({
			text: `Reply ID: ${threadMessage.localThreadMessageId} | ${staff.user.tag} (${staff.user.id})`,
			iconURL: staff.user.displayAvatarURL(),
		});
		options.embeds = [embed];
	}

	await guildMessage.edit(options as MessageEditOptions);
}
