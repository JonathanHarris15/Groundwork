import { USAGE_FEATURE_LABEL, type UsageReport } from "@groundwork/core";

/** Dashboard markup for an allowlisted admin. The page shell stays empty until this is returned. */
export function usageDash(report: UsageReport): string {
	const proposed = proposedLabel(report);
	const conversion = report.upgrades.clickers ? report.upgrades.convertedClickers / report.upgrades.clickers : null;
	return `${accountHead(report)}
					<h1>Free plan usage</h1>
					<p class="usage-actions"><button class="btn btn-line" type="button" id="download-csv">Download CSV</button></p>
					<p class="lede">${esc(report.meter)}</p>
					<p class="lede">${esc(report.consistentUser)}</p>
					<p class="fine">Generated ${esc(report.generatedAt)}. Counts and costs only. This page does not show note or chat text.</p>

					<section class="usage-section" aria-labelledby="proposal-title">
						<h2 id="proposal-title">Proposed Free limit</h2>
						${report.proposal.small ? `<p class="usage-warn" role="status">The sample is too small. ${report.proposal.sample} consistent free ${report.proposal.sample === 1 ? "user" : "users"} so far. 20 are needed before this range is a basis for the Free limit.</p>` : ""}
						<div class="usage-cards">
							${card("Current Free limit", money(report.limitUsd, 2))}
							${card("Proposed range", proposed)}
							${card("Sample", String(report.proposal.sample))}
							${card("Checkout clicks", String(report.upgrades.clicks))}
							${card("Click conversion", conversion == null ? "—" : pct(conversion * 100))}
						</div>
						<p class="fine">${esc(proposalNote(report))} Upgrade clicks are checkout starts. Conversion is the share of those accounts that Stripe then put on a paid plan. ${report.upgrades.upgrades} paid ${report.upgrades.upgrades === 1 ? "upgrade" : "upgrades"} in total, ${report.upgrades.convertedClickers} of them after a click.</p>
					</section>

					<section class="usage-section" aria-labelledby="week-title">
						<h2 id="week-title">Weekly active free users</h2>
						${barChart(report.weeks.map((week) => ({ label: week.week.slice(5), value: week.activeFree })), "Weekly active free users")}
						${table(
							"Weekly activity",
							["Week", "Active free users", "New free signups", "Checkout clicks"],
							report.weeks.map((week) => [week.week, String(week.activeFree), String(week.signups), String(week.checkouts)]),
						)}
					</section>

					<section class="usage-section" aria-labelledby="cohort-title">
						<h2 id="cohort-title">Return rate by signup week</h2>
						<p class="fine">Day 1, day 7, and day 30 are the UTC calendar days that many days after signup. The rate uses people for whom that day has already happened. A return is any recorded use that day.</p>
						${table(
							"Signup-week cohorts",
							["Signup week", "Free signups", "Day 1", "Day 7", "Day 30"],
							report.cohorts.map((row) => [row.week, String(row.size), rateCell(row.day1), rateCell(row.day7), rateCell(row.day30)]),
						)}
					</section>

					<section class="usage-section" aria-labelledby="days-title">
						<h2 id="days-title">Active days per user per month</h2>
						${table(
							"Active days",
							["Month", "Free users", "Mean active days", "Median active days"],
							report.activeDays.map((row) => [row.period, String(row.users), num(row.mean), num(row.median)]),
						)}
					</section>

					<section class="usage-section" aria-labelledby="limit-title">
						<h2 id="limit-title">Share of the Free limit</h2>
						<p class="fine">Percent is hosted USD charged in that calendar month, divided by the current Free allowance. A month still in progress is marked partial. Consistent users are the people who meet the definition above today.</p>
						${barChart(report.distribution.map((bin) => ({ label: bin.label, value: bin.count })), "Free users by share of the monthly limit, this month")}
						${report.limits
							.map((row) => {
								const head = `${row.period}${row.partial ? " (partial)" : ""}`;
								return `<h3>${esc(head)}</h3>${table(
									`${row.period} limit`,
									["Group", "Users", "Mean", "Median", "p75", "p90", "Hit 100%", "Median hit day", "Upgraded", "Waited", "Churned", "Open"],
									[
										limitLine("Everyone", row.overall, row),
										limitLine("Consistent", row.consistent, row),
									],
								)}`;
							})
							.join("")}
					</section>

					<section class="usage-section" aria-labelledby="feature-title">
						<h2 id="feature-title">This month by feature</h2>
						<p class="fine">Unknown is a plugin that did not send a feature, including 0.1.17, plus ledger spend from before daily rows existed. Light is Gemini 3.8 Flash. Heavy is Gemini 3.5 Flash.</p>
						${table(
							"Feature mix",
							["Feature", "Calls", "USD", "Input tokens", "Output tokens"],
							report.features.filter((row) => row.calls > 0 || row.costUsd > 0).map((row) => [USAGE_FEATURE_LABEL[row.feature], String(row.calls), money(row.costUsd, 4), String(row.inputTokens), String(row.outputTokens)]),
						)}
						${table(
							"Model mix",
							["Model", "Calls", "USD", "Input tokens", "Output tokens"],
							report.models.filter((row) => row.calls > 0 || row.costUsd > 0).map((row) => [modelLabel(row.model), String(row.calls), money(row.costUsd, 4), String(row.inputTokens), String(row.outputTokens)]),
						)}
					</section>

					<section class="usage-section" aria-labelledby="people-title">
						<h2 id="people-title">This month, per free user</h2>
						<p class="fine">Excluded accounts are flagged and left out of the totals above. Test accounts use a test email. GROUNDWORKTESTER is the coupon. Admin is the allowlisted sign-in.</p>
						<p class="fine">Excluded: ${report.excluded.admin} admin, ${report.excluded.coupon} coupon, ${report.excluded.test} test.</p>
						${peopleTable(report)}
					</section>`;
}

export function usageCsv(report: UsageReport): string {
	const lines: string[] = [];
	const push = (cells: Array<string | number | null>) => lines.push(cells.map(csvCell).join(","));
	push(["section", "usage"]);
	push(["generated_at", report.generatedAt]);
	push(["users", report.census.users]);
	push(["free", report.census.free]);
	push(["no_plan", report.census.noPlan]);
	push(["paid_plan_not_active", report.census.other]);
	push(["joined_last_7_days", report.census.joinedLast7Days]);
	push(["orphaned_records", report.census.orphans]);
	push(["paid_users", report.census.paid]);
	push(["paid_byom", report.census.byom]);
	push(["paid_groundwork", report.census.included]);
	push(["paying", report.census.paying]);
	push(["comped_groundworktester", report.census.comped]);
	push(["limit_usd", report.limitUsd]);
	push(["consistent_user", report.consistentUser]);
	push(["meter", report.meter]);
	push([]);
	push(["section", "proposal"]);
	push(["period", report.proposal.period]);
	push(["partial", report.proposal.partial ? "yes" : "no"]);
	push(["sample", report.proposal.sample]);
	push(["small_sample", report.proposal.small ? "yes" : "no"]);
	push(["p50_usd", report.proposal.p50Usd]);
	push(["p75_usd", report.proposal.p75Usd]);
	push(["proposed_low_usd", report.proposal.lowUsd]);
	push(["proposed_high_usd", report.proposal.highUsd]);
	push(["checkout_clicks", report.upgrades.clicks]);
	push(["checkout_accounts", report.upgrades.clickers]);
	push(["upgrades", report.upgrades.upgrades]);
	push(["converted_clickers", report.upgrades.convertedClickers]);
	push([]);
	push(["section", "weeks"]);
	push(["week", "active_free", "signups", "checkout_clicks"]);
	for (const week of report.weeks) push([week.week, week.activeFree, week.signups, week.checkouts]);
	push([]);
	push(["section", "cohorts"]);
	push(["week", "size", "day1_eligible", "day1_returned", "day1_rate", "day7_eligible", "day7_returned", "day7_rate", "day30_eligible", "day30_returned", "day30_rate"]);
	for (const row of report.cohorts) {
		push([row.week, row.size, row.day1.eligible, row.day1.returned, row.day1.rate, row.day7.eligible, row.day7.returned, row.day7.rate, row.day30.eligible, row.day30.returned, row.day30.rate]);
	}
	push([]);
	push(["section", "active_days"]);
	push(["period", "users", "mean", "median"]);
	for (const row of report.activeDays) push([row.period, row.users, row.mean, row.median]);
	push([]);
	push(["section", "limits"]);
	push(["period", "partial", "group", "users", "mean_pct", "median_pct", "p75_pct", "p90_pct", "mean_usd", "median_usd", "p75_usd", "p90_usd", "hit_100", "hit_100_share", "hit_day_median", "upgraded", "waited", "churned", "open"]);
	for (const row of report.limits) {
		for (const [group, moments] of [
			["overall", row.overall],
			["consistent", row.consistent],
		] as const) {
			push([
				row.period,
				row.partial ? "yes" : "no",
				group,
				moments.users,
				moments.meanPct,
				moments.medianPct,
				moments.p75Pct,
				moments.p90Pct,
				moments.meanUsd,
				moments.medianUsd,
				moments.p75Usd,
				moments.p90Usd,
				row.hit100,
				row.hit100Share,
				row.hitDayMedian,
				row.outcomes.upgraded,
				row.outcomes.waited,
				row.outcomes.churned,
				row.outcomes.open,
			]);
		}
	}
	push([]);
	push(["section", "features"]);
	push(["feature", "calls", "cost_usd", "input_tokens", "output_tokens"]);
	for (const row of report.features) push([row.feature, row.calls, row.costUsd, row.inputTokens, row.outputTokens]);
	push([]);
	push(["section", "users"]);
	push(["uid", "email", "period", "pct_of_limit", "cost_usd", "charged_usd", "hit_100", "hit_day", "outcome", "consistent", "excluded"]);
	for (const row of report.users) {
		push([row.uid, row.email, row.period, row.pct, row.costUsd, row.chargedUsd, row.hit ? "yes" : "no", row.hitDay, row.outcome, row.consistent ? "yes" : "no", row.excluded.join("|")]);
	}
	return `${lines.join("\n")}\n`;
}

function peopleTable(report: UsageReport): string {
	const rows = [...report.users].sort((a, b) => b.pct - a.pct);
	const shown = rows.slice(0, 100);
	const note = rows.length > shown.length ? `<p class="fine">Showing 100 of ${rows.length}. The CSV has every row.</p>` : "";
	return `${note}${table(
		"Per user",
		["Account", "Percent of limit", "USD", "Hit day", "After 100%", "Consistent", "Flag"],
		shown.map((row) => [
			row.email || row.uid,
			pct(row.pct),
			money(row.costUsd, 4),
			row.hitDay == null ? "—" : String(row.hitDay),
			row.outcome ?? "—",
			row.consistent ? "Yes" : "No",
			row.excluded.join(", ") || "—",
		]),
	)}`;
}

function limitLine(group: string, moments: UsageReport["limits"][number]["overall"], row: UsageReport["limits"][number]): string[] {
	const hits = group === "Everyone";
	return [
		group,
		String(moments.users),
		pct(moments.meanPct),
		pct(moments.medianPct),
		pct(moments.p75Pct),
		pct(moments.p90Pct),
		hits ? share(row.hit100, row.hit100Share) : "—",
		hits ? num(row.hitDayMedian) : "—",
		hits ? String(row.outcomes.upgraded) : "—",
		hits ? String(row.outcomes.waited) : "—",
		hits ? String(row.outcomes.churned) : "—",
		hits ? String(row.outcomes.open) : "—",
	];
}

function proposalNote(report: UsageReport): string {
	const when = report.proposal.partial ? `${report.proposal.period} is still open, so this range is low.` : `Based on ${report.proposal.period}.`;
	const p50 = report.proposal.p50Usd == null ? "—" : money(report.proposal.p50Usd, 4);
	const p75 = report.proposal.p75Usd == null ? "—" : money(report.proposal.p75Usd, 4);
	return `${when} Consistent free users' monthly USD is p50 ${p50} and p75 ${p75}. The proposed range is that pair times 0.9.`;
}

function proposedLabel(report: UsageReport): string {
	if (report.proposal.lowUsd == null || report.proposal.highUsd == null) return "—";
	return `${money(report.proposal.lowUsd, 2)}–${money(report.proposal.highUsd, 2)}`;
}

function rateCell(rate: { eligible: number; returned: number; rate: number | null }): string {
	if (rate.rate == null) return "—";
	return `${pct(rate.rate * 100)} (${rate.returned}/${rate.eligible})`;
}

function share(count: number, ratio: number | null): string {
	if (ratio == null) return "—";
	return `${count} (${pct(ratio * 100)})`;
}

function accountHead(report: UsageReport): string {
	const census = report.census;
	const paidRows: Array<[string, number]> = [
		["Bring your own model", census.byom],
		["Groundwork", census.included],
		["Paying", census.paying],
		["Comped on GROUNDWORKTESTER", census.comped],
	];
	const other = census.paid - census.paying - census.comped;
	if (other > 0) paidRows.push(["Not paying, other", other]);
	const userRows: Array<[string, number]> = [
		["Free", census.free],
		["No plan", census.noPlan],
	];
	if (census.other > 0) userRows.push(["Paid plan, not active", census.other]);
	userRows.push(["Joined in the last 7 days", census.joinedLast7Days]);
	return `<section class="usage-head" aria-label="Account counts">
						<div class="usage-head-cards">
							${statCard("users-count", "Users", census.users, userRows)}
							${statCard("paid-count", "Paid users", census.paid, paidRows, "Paying means more than $0 after discounts. Comped is the 100% off GROUNDWORKTESTER coupon.")}
						</div>
						<p class="usage-orphans">Orphaned records <span>${census.orphans}</span></p>
					</section>`;
}

function statCard(id: string, label: string, value: number, rows: Array<[string, number]>, note?: string): string {
	const lines = rows.map(([name, count]) => `<div><dt>${esc(name)}</dt><dd>${count}</dd></div>`).join("");
	const extra = note ? `<p class="usage-stat-note">${esc(note)}</p>` : "";
	return `<article class="usage-card usage-stat" aria-labelledby="${id}"><p class="k" id="${id}">${esc(label)}</p><p class="v">${value}</p><dl class="usage-split">${lines}</dl>${extra}</article>`;
}

function card(label: string, value: string): string {
	return `<div class="usage-card"><p class="k">${esc(label)}</p><p class="v">${esc(value)}</p></div>`;
}

function table(caption: string, headers: string[], rows: string[][]): string {
	const head = headers.map((header) => `<th scope="col">${esc(header)}</th>`).join("");
	const body = rows.length
		? rows.map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join("")}</tr>`).join("")
		: `<tr><td colspan="${headers.length}">No rows yet.</td></tr>`;
	return `<div class="usage-scroll"><table class="usage-table"><caption>${esc(caption)}</caption><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function barChart(rows: Array<{ label: string; value: number }>, label: string): string {
	if (!rows.length) return "";
	const width = 640;
	const height = 168;
	const max = Math.max(1, ...rows.map((row) => row.value));
	const gap = 6;
	const bar = (width - gap * (rows.length + 1)) / rows.length;
	const shapes = rows
		.map((row, index) => {
			const h = Math.max(0, Math.round((row.value / max) * (height - 36)));
			const x = gap + index * (bar + gap);
			const y = height - 22 - h;
			const w = Math.max(bar, 1);
			const labelX = (x + w / 2).toFixed(1);
			return `<g><rect x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${h}" rx="3" fill="#2e9be6"><title>${esc(row.label)}: ${row.value}</title></rect><text x="${labelX}" y="${height - 6}" text-anchor="middle" fill="#4a4f57" font-size="11" font-family="Jost, sans-serif">${esc(row.label)}</text></g>`;
		})
		.join("");
	return `<svg class="usage-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}">${shapes}</svg>`;
}

function modelLabel(model: "light" | "heavy" | "unknown"): string {
	if (model === "light") return "Light";
	if (model === "heavy") return "Heavy";
	return "Unknown";
}

function money(value: number, digits: number): string {
	return `$${value.toFixed(digits)}`;
}

function pct(value: number | null): string {
	if (value == null || Number.isNaN(value)) return "—";
	return `${value.toFixed(1)}%`;
}

function num(value: number | null): string {
	if (value == null || Number.isNaN(value)) return "—";
	return value.toFixed(2);
}

function esc(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function csvCell(value: string | number | null | boolean): string {
	if (value == null) return "";
	const text = String(value);
	const guarded = /^[=+\-@]/.test(text) ? `'${text}` : text;
	if (/[",\n]/.test(guarded)) return `"${guarded.replace(/"/g, '""')}"`;
	return guarded;
}
