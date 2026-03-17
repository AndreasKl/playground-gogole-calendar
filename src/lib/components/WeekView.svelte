<script lang="ts">
	import { onMount } from 'svelte';
	import type { CalendarEvent, DbCalendar } from '$lib/types';
	import EventModal from './EventModal.svelte';
	import { locale } from '$lib/stores/locale.svelte';
	import { formatHour, formatEventTime, formatWeekRange, getWeekDayNames } from '$lib/utils/format';

	// ─── Week state ────────────────────────────────────────────────────────────
	let weekOffset = $state(0);

	const HOUR_HEIGHT = 64; // px per hour
	const DAY_START   = 0;
	const DAY_END     = 24;

	function getWeekStart(offset: number): Date {
		const now = new Date();
		const day = now.getDay();
		const monday = new Date(now);
		monday.setDate(now.getDate() - ((day + 6) % 7) + offset * 7);
		monday.setHours(0, 0, 0, 0);
		return monday;
	}

	let weekStart = $derived(getWeekStart(weekOffset));
	let weekDays  = $derived(Array.from({ length: 7 }, (_, i) => {
		const d = new Date(weekStart);
		d.setDate(weekStart.getDate() + i);
		return d;
	}));

	// ─── Data ──────────────────────────────────────────────────────────────────
	let events    = $state<CalendarEvent[]>([]);
	let calendars = $state<DbCalendar[]>([]);
	let loading   = $state(false);
	let fetchError = $state<string | null>(null);

	async function fetchCalendars() {
		const res = await fetch('/api/calendars');
		if (res.ok) calendars = await res.json();
	}

	async function fetchEvents() {
		loading = true;
		fetchError = null;
		try {
			const start = weekDays[0].toISOString();
			const end   = (() => { const d = new Date(weekDays[6]); d.setHours(23,59,59,999); return d.toISOString(); })();
			const res   = await fetch(`/api/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
			if (!res.ok) throw new Error(await res.text());
			events = await res.json();
		} catch (e) {
			fetchError = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	$effect(() => { weekStart; fetchEvents(); });
	onMount(fetchCalendars);

	// ─── Event positioning ─────────────────────────────────────────────────────

	function dayBounds(day: Date): { start: Date; end: Date } {
		const start = new Date(day); start.setHours(0, 0, 0, 0);
		const end   = new Date(day); end.setHours(23, 59, 59, 999);
		return { start, end };
	}

	/** Top offset for the visible segment of ev on this day (clipped to midnight) */
	function eventTop(ev: CalendarEvent, day: Date): number {
		const { start: dayStart } = dayBounds(day);
		const evStart = new Date(ev.starts_at);
		const displayStart = evStart < dayStart ? dayStart : evStart;
		return (displayStart.getHours() * 60 + displayStart.getMinutes()) / 60 * HOUR_HEIGHT;
	}

	/** Pixel height for the visible segment of ev on this day */
	function eventHeight(ev: CalendarEvent, day: Date): number {
		const { start: dayStart, end: dayEnd } = dayBounds(day);
		const evStart = new Date(ev.starts_at);
		const evEnd   = new Date(ev.ends_at);
		const displayStart = evStart < dayStart ? dayStart : evStart;
		const displayEnd   = evEnd   > dayEnd   ? dayEnd   : evEnd;
		const mins = (displayEnd.getTime() - displayStart.getTime()) / 60000;
		return Math.max(mins / 60 * HOUR_HEIGHT, 20);
	}

	/** Whether ev continues beyond the end of this day */
	function continuesNextDay(ev: CalendarEvent, day: Date): boolean {
		const { end: dayEnd } = dayBounds(day);
		return new Date(ev.ends_at) > dayEnd;
	}

	/** Whether ev started before this day (continuation segment) */
	function continuedFromPrev(ev: CalendarEvent, day: Date): boolean {
		const { start: dayStart } = dayBounds(day);
		return new Date(ev.starts_at) < dayStart;
	}

	/** Match any event that overlaps the given day */
	function eventsForDay(day: Date): CalendarEvent[] {
		const { start: dayStart, end: dayEnd } = dayBounds(day);
		return events.filter(ev =>
			new Date(ev.starts_at) < dayEnd && new Date(ev.ends_at) > dayStart
		);
	}

	// ─── Column overlap stacking ───────────────────────────────────────────────

	interface PositionedEvent { ev: CalendarEvent; col: number; cols: number; }

	function layoutDayEvents(dayEvs: CalendarEvent[]): PositionedEvent[] {
		const sorted = [...dayEvs].sort((a, b) =>
			new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime()
		);
		const placed: PositionedEvent[] = [];
		const colEnds: Date[] = [];

		for (const ev of sorted) {
			const start = new Date(ev.starts_at);
			let col = 0;
			while (colEnds[col] && colEnds[col] > start) col++;
			colEnds[col] = new Date(ev.ends_at);
			placed.push({ ev, col, cols: 1 });
		}

		const maxCols = colEnds.length || 1;
		for (const p of placed) p.cols = maxCols;
		return placed;
	}

	// ─── Helpers ───────────────────────────────────────────────────────────────

	function isToday(d: Date): boolean {
		const now = new Date();
		return d.getFullYear() === now.getFullYear()
			&& d.getMonth()     === now.getMonth()
			&& d.getDate()      === now.getDate();
	}

	let nowTop = $state((new Date().getHours() * 60 + new Date().getMinutes()) / 60 * HOUR_HEIGHT);
	setInterval(() => {
		const now = new Date();
		nowTop = (now.getHours() * 60 + now.getMinutes()) / 60 * HOUR_HEIGHT;
	}, 60000);

	// ─── Modal ─────────────────────────────────────────────────────────────────

	let modalOpen        = $state(false);
	let editingEvent     = $state<CalendarEvent | null>(null);
	let newEventDefaults = $state<{ starts_at: string; ends_at: string } | null>(null);

	function openNewEvent(day: Date, hour: number) {
		const start = new Date(day); start.setHours(hour, 0, 0, 0);
		const end   = new Date(start); end.setHours(hour + 1);
		newEventDefaults = { starts_at: start.toISOString(), ends_at: end.toISOString() };
		editingEvent = null;
		modalOpen = true;
	}

	function openEditEvent(ev: CalendarEvent, e: MouseEvent) {
		e.stopPropagation();
		editingEvent = ev;
		newEventDefaults = null;
		modalOpen = true;
	}

	function handleSaved() { modalOpen = false; fetchEvents(); }

	// ─── Formatting ────────────────────────────────────────────────────────────

	let dayNames = $derived(getWeekDayNames(locale.config));
</script>

<div class="flex flex-col h-screen bg-white overflow-hidden font-sans text-sm text-gray-800">

	<!-- ── Header ─────────────────────────────────────────────────────────── -->
	<header class="flex items-center gap-4 px-5 py-3 border-b border-border shrink-0">
		<div class="flex items-center gap-2">
			<button
				onclick={() => weekOffset--}
				aria-label="Previous week"
				class="w-8 h-8 rounded-full border border-border bg-white hover:bg-surface-2 grid place-items-center text-lg leading-none transition-colors"
			>‹</button>
			<button
				onclick={() => weekOffset = 0}
				class="px-3.5 py-1.5 rounded border border-border bg-white hover:bg-surface-2 text-sm transition-colors"
			>Today</button>
			<button
				onclick={() => weekOffset++}
				aria-label="Next week"
				class="w-8 h-8 rounded-full border border-border bg-white hover:bg-surface-2 grid place-items-center text-lg leading-none transition-colors"
			>›</button>
		</div>

		<h1 class="text-lg font-normal text-gray-800">{formatWeekRange(weekDays, locale.config)}</h1>

		{#if loading}
			<span class="ml-auto text-xs text-text-muted">Loading…</span>
		{/if}
	</header>

	{#if fetchError}
		<div class="bg-danger-light text-danger text-xs px-5 py-2 shrink-0">{fetchError}</div>
	{/if}

	<!-- ── Day header row ─────────────────────────────────────────────────── -->
	<div class="grid border-b border-border shrink-0 pr-3" style="grid-template-columns: 60px repeat(7, 1fr)">
		<div></div>
		{#each weekDays as day, i}
			<div class="flex flex-col items-center py-2 gap-0.5" class:text-primary={isToday(day)}>
				<span class="text-[11px] font-medium uppercase tracking-wide text-text-muted" class:text-primary={isToday(day)}>
					{dayNames[i]}
				</span>
				<span
					class="text-[22px] font-normal w-9 h-9 grid place-items-center rounded-full"
					class:bg-primary={isToday(day)}
					class:text-white={isToday(day)}
				>{day.getDate()}</span>
			</div>
		{/each}
	</div>

	<!-- ── Scrollable time grid ───────────────────────────────────────────── -->
	<div class="flex-1 overflow-y-auto overflow-x-hidden">
		<div
			class="time-grid"
			style="--hour-height:{HOUR_HEIGHT}px; --hours:{DAY_END - DAY_START}; grid-template-columns: 60px repeat(7, 1fr)"
		>
			<!-- Hour labels -->
			<div class="relative">
				{#each Array.from({ length: DAY_END - DAY_START }, (_, i) => i) as hour}
					<div class="hour-label flex items-start justify-end pr-2 pt-0.5 text-[11px] text-text-muted whitespace-nowrap box-border">
						{formatHour(hour, locale.config)}
					</div>
				{/each}
			</div>

			<!-- Day columns -->
			{#each weekDays as day}
				{@const dayEvs = layoutDayEvents(eventsForDay(day))}
				<div class="relative border-l border-border {isToday(day) ? 'bg-blue-50/30' : ''}">

					<!-- Hour cells (clickable) -->
					{#each Array.from({ length: DAY_END - DAY_START }, (_, i) => i) as hour}
						<div
							class="hour-cell w-full border-b border-border hover:bg-primary-light/60 cursor-pointer transition-colors"
							role="button"
							tabindex="0"
							aria-label="New event at {formatHour(hour, locale.config)}"
							onclick={() => openNewEvent(day, hour)}
							onkeydown={(e) => e.key === 'Enter' && openNewEvent(day, hour)}
						></div>
					{/each}

					<!-- Current time indicator -->
					{#if isToday(day)}
						<div class="absolute left-0 right-0 z-10 pointer-events-none" style="top:{nowTop}px">
							<div class="relative h-0.5 bg-danger">
								<div class="absolute -left-1 -top-1.5 w-3 h-3 rounded-full bg-danger"></div>
							</div>
						</div>
					{/if}

					<!-- Event blocks -->
					{#each dayEvs as { ev, col, cols }}
						{@const spansNext = continuesNextDay(ev, day)}
						{@const spannedFromPrev = continuedFromPrev(ev, day)}
						<button
							class="absolute px-1.5 py-0.5 overflow-hidden text-left text-xs leading-snug z-5 transition-[filter] hover:brightness-90 cursor-pointer font-sans
								{spannedFromPrev ? 'rounded-b' : 'rounded-t'}
								{spansNext ? 'rounded-b-none' : 'rounded-b'}"
							style="
								top:{eventTop(ev, day)}px;
								height:{eventHeight(ev, day)}px;
								left:calc({col}/{cols} * 100% + 2px);
								width:calc(1/{cols} * 100% - 4px);
								background-color:{ev.calendar_color}22;
								border-left:3px solid {ev.calendar_color};
								{spansNext ? `border-bottom:2px dashed ${ev.calendar_color}88;` : ''}
								color:{ev.calendar_color};
							"
							onclick={(e) => openEditEvent(ev, e)}
							title="{ev.title}\n{formatEventTime(ev.starts_at, ev.ends_at, locale.config)}"
						>
							{#if spannedFromPrev}
								<span class="block font-medium truncate opacity-70">↳ {ev.title}</span>
							{:else}
								<span class="block font-medium truncate">{ev.title}</span>
								{#if eventHeight(ev, day) > 36}
									<span class="block text-[11px] opacity-80">{formatEventTime(ev.starts_at, ev.ends_at, locale.config)}</span>
								{/if}
							{/if}
							{#if spansNext}
								<span class="absolute bottom-0.5 right-1 text-[10px] opacity-60">→</span>
							{/if}
							{#if ev.is_recurring && !spansNext}
								<span class="absolute top-0.5 right-1 text-[10px] opacity-60" title="Recurring">↺</span>
							{/if}
						</button>
					{/each}
				</div>
			{/each}
		</div>
	</div>
</div>

{#if modalOpen}
	<EventModal
		event={editingEvent}
		defaults={newEventDefaults}
		{calendars}
		onclose={() => { modalOpen = false; }}
		onsaved={handleSaved}
	/>
{/if}

<style>
/* Only the parts that need CSS-variable arithmetic — everything else is Tailwind */
.time-grid {
	display: grid;
	height: calc(var(--hours) * var(--hour-height));
	min-height: calc(var(--hours) * var(--hour-height));
	position: relative;
}
.hour-label {
	height: var(--hour-height);
}
.hour-cell {
	height: var(--hour-height);
}
</style>
