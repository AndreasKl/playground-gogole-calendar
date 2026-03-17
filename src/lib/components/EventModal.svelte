<script lang="ts">
	import type { CalendarEvent, DbCalendar, RecurrenceRule, WeekDay } from '$lib/types';

	let {
		event    = null,
		defaults = null,
		calendars,
		onclose,
		onsaved,
	}: {
		event:     CalendarEvent | null;
		defaults:  { starts_at: string; ends_at: string } | null;
		calendars: DbCalendar[];
		onclose:   () => void;
		onsaved:   () => void;
	} = $props();

	const isEdit = $derived(event !== null);

	function toLocalInput(iso: string): string {
		const d = new Date(iso);
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
	}

	let title       = $state(event?.title       ?? '');
	let description = $state(event?.description ?? '');
	let location    = $state(event?.location    ?? '');
	let calendarId  = $state(event?.calendar_id ?? (calendars[0]?.id ?? ''));
	let startsAt    = $state(toLocalInput(event?.starts_at ?? defaults?.starts_at ?? new Date().toISOString()));
	let endsAt      = $state(toLocalInput(event?.ends_at   ?? defaults?.ends_at   ?? new Date().toISOString()));

	let isRecurring = $state(event?.is_recurring ?? false);
	let frequency   = $state<RecurrenceRule['frequency']>(event?.recurrence_rule?.frequency ?? 'weekly');
	let interval    = $state(event?.recurrence_rule?.interval ?? 1);
	let byday       = $state<Set<WeekDay>>(new Set(event?.recurrence_rule?.byday ?? []));
	let untilMode   = $state<'forever' | 'until' | 'count'>(
		event?.recurrence_rule?.until  ? 'until'  :
		event?.recurrence_rule?.count  ? 'count'  : 'forever'
	);
	// svelte-ignore state_referenced_locally
	let untilDate = $state(event?.recurrence_rule?.until ?? '');
	// svelte-ignore state_referenced_locally
	let count     = $state(event?.recurrence_rule?.count ?? 10);
	let editScope = $state<'this' | 'this_and_future' | 'all'>('all');

	const DAYS: { label: string; value: WeekDay }[] = [
		{ label: 'M', value: 'MO' },
		{ label: 'T', value: 'TU' },
		{ label: 'W', value: 'WE' },
		{ label: 'T', value: 'TH' },
		{ label: 'F', value: 'FR' },
		{ label: 'S', value: 'SA' },
		{ label: 'S', value: 'SU' },
	];

	function toggleDay(d: WeekDay) {
		const s = new Set(byday);
		s.has(d) ? s.delete(d) : s.add(d);
		byday = s;
	}

	function buildRule(): RecurrenceRule | undefined {
		if (!isRecurring) return undefined;
		const rule: RecurrenceRule = { frequency, interval };
		if (frequency === 'weekly' && byday.size > 0) rule.byday = [...byday];
		if (untilMode === 'until' && untilDate) rule.until = untilDate;
		if (untilMode === 'count') rule.count = count;
		return rule;
	}

	let saving  = $state(false);
	let saveErr = $state<string | null>(null);

	async function handleSubmit() {
		saving = true; saveErr = null;
		try {
			const rule    = buildRule();
			const payload = {
				calendar_id: calendarId,
				title:       title.trim(),
				description: description.trim() || undefined,
				location:    location.trim()    || undefined,
				starts_at:   new Date(startsAt).toISOString(),
				ends_at:     new Date(endsAt).toISOString(),
				recurrence_rule: rule,
			};
			let res: Response;
			if (isEdit && event) {
				res = await fetch(`/api/events/${event.id}`, {
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ ...payload, scope: editScope, occurrence_starts_at: event.occurrence_starts_at }),
				});
			} else {
				res = await fetch('/api/events', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(payload),
				});
			}
			if (!res.ok) throw new Error(await res.text());
			onsaved();
		} catch (e) {
			saveErr = e instanceof Error ? e.message : String(e);
		} finally {
			saving = false;
		}
	}

	async function handleDelete() {
		if (!event) return;
		const msg = event.is_recurring && editScope !== 'all'
			? `Delete ${editScope === 'this' ? 'this occurrence' : 'this and all future occurrences'}?`
			: 'Delete this event?';
		if (!confirm(msg)) return;
		saving = true; saveErr = null;
		try {
			const res = await fetch(`/api/events/${event.id}`, {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ scope: editScope, occurrence_starts_at: event.occurrence_starts_at }),
			});
			if (!res.ok && res.status !== 204) throw new Error(await res.text());
			onsaved();
		} catch (e) {
			saveErr = e instanceof Error ? e.message : String(e);
		} finally {
			saving = false;
		}
	}

	function handleBackdrop(e: MouseEvent) {
		if ((e.target as Element).classList.contains('modal-backdrop')) onclose();
	}

	function focusOnMount(node: HTMLElement) {
		node.focus();
	}
</script>

<div
	class="modal-backdrop fixed inset-0 bg-black/35 grid place-items-center z-50"
	role="presentation"
	onclick={handleBackdrop}
	onkeydown={(e) => e.key === 'Escape' && onclose()}
>
	<div
		class="bg-white rounded-lg shadow-xl w-[480px] max-w-[95vw] max-h-[90vh] overflow-y-auto flex flex-col"
		role="dialog"
		aria-modal="true"
		aria-label={isEdit ? 'Edit event' : 'New event'}
	>
		<!-- Header -->
		<div class="flex items-center justify-between px-5 pt-4 pb-3 border-b border-border">
			<h2 class="text-lg font-medium">{isEdit ? 'Edit event' : 'New event'}</h2>
			<button
				onclick={onclose}
				aria-label="Close"
				class="text-text-muted hover:bg-surface-2 rounded p-1 leading-none text-base transition-colors"
			>✕</button>
		</div>

		<!-- Body -->
		<form class="flex flex-col gap-3 px-5 py-4" onsubmit={(e) => { e.preventDefault(); handleSubmit(); }}>

			<!-- Title -->
			<div class="flex flex-col gap-1">
				<label class="text-xs font-medium text-text-muted" for="ev-title">Title</label>
				<input
					id="ev-title"
					type="text"
					bind:value={title}
					required
					placeholder="Add title"
					use:focusOnMount
					class="border border-border rounded px-2.5 py-1.5 text-sm focus:outline-none focus:border-primary w-full"
				/>
			</div>

			<!-- Times -->
			<div class="grid grid-cols-2 gap-3">
				<div class="flex flex-col gap-1">
					<label class="text-xs font-medium text-text-muted" for="ev-start">Start</label>
					<input id="ev-start" type="datetime-local" bind:value={startsAt} required
						class="border border-border rounded px-2.5 py-1.5 text-sm focus:outline-none focus:border-primary w-full" />
				</div>
				<div class="flex flex-col gap-1">
					<label class="text-xs font-medium text-text-muted" for="ev-end">End</label>
					<input id="ev-end" type="datetime-local" bind:value={endsAt} required
						class="border border-border rounded px-2.5 py-1.5 text-sm focus:outline-none focus:border-primary w-full" />
				</div>
			</div>

			<!-- Calendar -->
			<div class="flex flex-col gap-1">
				<label class="text-xs font-medium text-text-muted" for="ev-cal">Calendar</label>
				<select id="ev-cal" bind:value={calendarId}
					class="border border-border rounded px-2.5 py-1.5 text-sm focus:outline-none focus:border-primary w-full bg-white">
					{#each calendars as cal}
						<option value={cal.id}>{cal.name}</option>
					{/each}
				</select>
			</div>

			<!-- Location -->
			<div class="flex flex-col gap-1">
				<label class="text-xs font-medium text-text-muted" for="ev-loc">Location</label>
				<input id="ev-loc" type="text" bind:value={location} placeholder="Add location"
					class="border border-border rounded px-2.5 py-1.5 text-sm focus:outline-none focus:border-primary w-full" />
			</div>

			<!-- Description -->
			<div class="flex flex-col gap-1">
				<label class="text-xs font-medium text-text-muted" for="ev-desc">Description</label>
				<textarea id="ev-desc" bind:value={description} rows="2" placeholder="Add description"
					class="border border-border rounded px-2.5 py-1.5 text-sm focus:outline-none focus:border-primary w-full resize-y"></textarea>
			</div>

			<!-- Repeat toggle -->
			<label class="flex items-center gap-2 text-sm cursor-pointer select-none">
				<input type="checkbox" bind:checked={isRecurring} class="rounded" />
				Repeat
			</label>

			{#if isRecurring}
				<div class="bg-surface-2 rounded-lg p-3 flex flex-col gap-3">

					<!-- Frequency + interval -->
					<div class="grid grid-cols-2 gap-2">
						<div class="flex flex-col gap-1">
							<label class="text-xs font-medium text-text-muted" for="ev-freq">Repeats</label>
							<select id="ev-freq" bind:value={frequency}
								class="border border-border rounded px-2 py-1.5 text-sm focus:outline-none focus:border-primary bg-white w-full">
								<option value="daily">Daily</option>
								<option value="weekly">Weekly</option>
								<option value="monthly">Monthly</option>
								<option value="yearly">Yearly</option>
							</select>
						</div>
						<div class="flex flex-col gap-1">
							<label class="text-xs font-medium text-text-muted" for="ev-interval">Every</label>
							<input id="ev-interval" type="number" min="1" max="99" bind:value={interval}
								class="border border-border rounded px-2 py-1.5 text-sm focus:outline-none focus:border-primary w-full" />
						</div>
					</div>

					<!-- Days of week (weekly only) -->
					{#if frequency === 'weekly'}
						<div class="flex flex-col gap-1.5">
							<span class="text-xs font-medium text-text-muted">On days</span>
							<div class="flex gap-1">
								{#each DAYS as d}
									<button
										type="button"
										onclick={() => toggleDay(d.value)}
										aria-pressed={byday.has(d.value)}
										aria-label={d.value}
										class="w-8 h-8 rounded-full text-xs font-medium border transition-colors
											{byday.has(d.value)
												? 'bg-primary border-primary text-white'
												: 'border-border bg-white text-text-muted hover:bg-surface-2'}"
									>{d.label}</button>
								{/each}
							</div>
						</div>
					{/if}

					<!-- End condition -->
					<div class="flex flex-col gap-1">
						<label class="text-xs font-medium text-text-muted" for="ev-until-mode">Ends</label>
						<select id="ev-until-mode" bind:value={untilMode}
							class="border border-border rounded px-2 py-1.5 text-sm focus:outline-none focus:border-primary bg-white w-full">
							<option value="forever">Never</option>
							<option value="until">On date</option>
							<option value="count">After N occurrences</option>
						</select>
					</div>

					{#if untilMode === 'until'}
						<div class="flex flex-col gap-1">
							<label class="text-xs font-medium text-text-muted" for="ev-until">End date</label>
							<input id="ev-until" type="date" bind:value={untilDate}
								class="border border-border rounded px-2 py-1.5 text-sm focus:outline-none focus:border-primary w-full" />
						</div>
					{:else if untilMode === 'count'}
						<div class="flex flex-col gap-1">
							<label class="text-xs font-medium text-text-muted" for="ev-count">Occurrences</label>
							<input id="ev-count" type="number" min="1" max="999" bind:value={count}
								class="border border-border rounded px-2 py-1.5 text-sm focus:outline-none focus:border-primary w-full" />
						</div>
					{/if}
				</div>
			{/if}

			<!-- Edit scope (existing recurring) -->
			{#if isEdit && event?.is_recurring}
				<div class="border border-border rounded-lg p-3 flex flex-col gap-2">
					<p class="text-xs font-medium text-text-muted">Apply changes to:</p>
					{#each [
						{ value: 'this',            label: 'This event only' },
						{ value: 'this_and_future', label: 'This and following events' },
						{ value: 'all',             label: 'All events in series' },
					] as opt}
						<label class="flex items-center gap-2 text-sm cursor-pointer">
							<input type="radio" bind:group={editScope} value={opt.value} />
							{opt.label}
						</label>
					{/each}
				</div>
			{/if}

			{#if saveErr}
				<p class="text-xs bg-danger-light text-danger px-3 py-2 rounded">{saveErr}</p>
			{/if}

			<!-- Actions -->
			<div class="flex items-center gap-2 justify-end pt-1">
				{#if isEdit}
					<button
						type="button"
						onclick={handleDelete}
						disabled={saving}
						class="mr-auto px-4 py-2 rounded text-sm font-medium bg-danger-light text-danger hover:brightness-95 disabled:opacity-60 transition-colors"
					>Delete</button>
				{/if}
				<button
					type="button"
					onclick={onclose}
					disabled={saving}
					class="px-4 py-2 rounded text-sm font-medium bg-surface-2 text-gray-700 hover:bg-border-strong disabled:opacity-60 transition-colors"
				>Cancel</button>
				<button
					type="submit"
					disabled={saving}
					class="px-4 py-2 rounded text-sm font-medium bg-primary text-white hover:bg-primary-hover disabled:opacity-60 transition-colors"
				>{saving ? 'Saving…' : isEdit ? 'Save' : 'Create'}</button>
			</div>
		</form>
	</div>
</div>
