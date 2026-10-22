/** Preferred method and one quote, shown on the Goals table and the Concepts list. Provenance is text, not a link. */

export interface CourseView {
	preferredMethod?: string | null;
	conflict?: string | null;
	excerpts?: Array<{ quote: string; provenance: string }>;
}

export interface CourseSnippet {
	preferred?: string;
	conflict?: string;
	quote?: string;
	where?: string;
}

export function courseSnippet(course: CourseView | null | undefined): CourseSnippet | undefined {
	if (!course) return undefined;
	const quote = course.excerpts?.[0];
	const preferred = course.conflict ? undefined : course.preferredMethod || undefined;
	if (!preferred && !course.conflict && !quote) return undefined;
	return {
		...(preferred ? { preferred } : {}),
		...(course.conflict ? { conflict: course.conflict } : {}),
		...(quote ? { quote: quote.quote, where: quote.provenance } : {}),
	};
}

export function appendCourseDetail(parent: HTMLElement, course: CourseSnippet | undefined): void {
	if (!course) return;
	const block = document.createElement("div");
	block.className = "gw-concept-course";
	if (course.conflict || course.preferred) {
		const method = document.createElement("p");
		method.className = "gw-course-method";
		method.textContent = course.conflict ?? `Preferred method: ${course.preferred}`;
		block.append(method);
	}
	if (course.quote) {
		const quote = document.createElement("blockquote");
		quote.className = "gw-course-quote";
		quote.textContent = course.quote;
		if (course.where) {
			const cite = document.createElement("cite");
			cite.textContent = course.where;
			quote.append(cite);
		}
		block.append(quote);
	}
	parent.append(block);
}
