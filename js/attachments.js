/* Copyright (C) 2026 THERSANE
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * E-mail attachments picker: loads the files that can be attached and applies the selection in ajax,
 * without reloading the card (the text typed in the e-mail is kept).
 *
 * Instance values come from the data attributes of button#attachments-launcher (printed by the getFormMail hook).
 * Without the Dolibarr JS context (Dolibarr < 24 without backportdolcontext), the launcher falls back to the
 * page reload flow (action attachments_send).
 */
(function () {
	'use strict';

	const LANG_DOMAINS = ['attachments@attachments', 'main'];

	/**
	 * Translation through Dolibarr.tools.langs, with sprintf like arguments.
	 * Plain text (no HTML entities): every output goes through esc() or textContent.
	 * @param {string} key
	 * @param {...*} args
	 * @returns {string}
	 */
	const t = (key, ...args) => Dolibarr.tools.langs.transNoEntities(key, ...args);

	/**
	 * Escape a string for HTML
	 * @param {string} str
	 * @returns {string}
	 */
	const esc = (str) => String(str).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

	/**
	 * Page reload flow (old behaviour), used when the Dolibarr JS context is missing
	 */
	const legacySend = () => {
		const action = document.getElementById('action');
		const addfile = document.getElementById('addfile');
		if (!action || !addfile) return;
		action.value = 'attachments_send';
		addfile.click();
	};

	/**
	 * Put the launcher next to the native "Attach file" button
	 * @param {HTMLElement} launcher
	 */
	const placeLauncher = (launcher) => {
		const addfile = document.getElementById('addfile');
		const removedHidden = document.querySelector('#mailform .removedfilehidden');
		if (addfile) {
			addfile.after(launcher);
		} else if (removedHidden) {
			removedHidden.parentElement.appendChild(launcher);
		} else {
			return;
		}
		launcher.hidden = false;
	};

	/**
	 * Native trash buttons (input.removedfile, submit the whole form) are handled in ajax: capture phase so the
	 * form is never submitted. Works on rows printed by the core and on rows rebuilt in ajax.
	 * @param {HTMLElement} launcher
	 */
	const bindRemoveButtons = (launcher) => {
		let busy = false;

		document.addEventListener('click', async (e) => {
			const btn = e.target.closest('#mailform input.removedfile');
			if (!btn) return;
			e.preventDefault();
			e.stopImmediatePropagation();
			if (busy) return;

			const row = btn.closest('div[id^="attachfile_"]');
			const key = parseInt(btn.value, 10) - 1; // value is the position + 1 (core convention)
			if (!row || isNaN(key) || key < 0) return;

			busy = true;
			row.classList.add('attachments-row--removing');
			btn.disabled = true;

			const input = document.querySelector('#mailform input[name="token"]');
			const body = new FormData();
			body.append('token', input && input.value ? input.value : launcher.dataset.token);
			body.append('mode', 'remove');
			body.append('element', launcher.dataset.element);
			body.append('id', launcher.dataset.id);
			body.append('trackid', launcher.dataset.trackid);
			body.append('key', String(key));
			body.append('name', row.textContent.trim());

			let data = null;
			try {
				const response = await fetch(launcher.dataset.url, {method: 'POST', body, credentials: 'same-origin', headers: {'Accept': 'application/json'}});
				data = await response.json().catch(() => null);
			} catch (err) {
				data = null;
			}

			busy = false;
			if (data && typeof data.attachedHtml === 'string') {
				replaceAttachedRows(data.attachedHtml);
			} else {
				row.classList.remove('attachments-row--removing');
				btn.disabled = false;
			}

			if (data && data.success) {
				Dolibarr.tools.setEventMessage(t('AttachmentsNbRemoved', 1));
			} else {
				Dolibarr.tools.setEventMessage((data && data.message) || t('AttachmentsApplyError'), 'errors');
			}
		}, true);
	};

	/**
	 * Replace the attached files rows of the e-mail form
	 * @param {string} html
	 */
	const replaceAttachedRows = (html) => {
		const oldRows = Array.from(document.querySelectorAll('#mailform div[id^="attachfile_"]'));
		const tpl = document.createElement('template');
		tpl.innerHTML = html;
		const newNodes = Array.from(tpl.content.childNodes);

		let anchor = oldRows.length ? oldRows[0] : document.getElementById('addedfile');
		if (anchor) {
			newNodes.forEach((node) => anchor.parentNode.insertBefore(node, anchor));
		} else {
			const removedHidden = document.querySelector('#mailform .removedfilehidden');
			if (!removedHidden) return;
			newNodes.forEach((node) => removedHidden.parentElement.appendChild(node));
		}
		oldRows.forEach((row) => row.remove());

		// Preview links (the core binds them at page load only)
		newNodes.forEach((node) => {
			if (!(node instanceof HTMLElement)) return;
			node.querySelectorAll('a.documentpreview').forEach((link) => {
				link.addEventListener('click', (e) => {
					if (typeof window.document_preview !== 'function') return;
					e.preventDefault();
					window.document_preview(link.getAttribute('href'), link.getAttribute('mime'), link.dataset.title || t('Preview'));
				});
			});
		});

		if (typeof Dolibarr.initNewContent === 'function') {
			newNodes.forEach((node) => node instanceof HTMLElement && Dolibarr.initNewContent(node));
		}
	};

	class AttachmentsPicker {
		/**
		 * @param {HTMLElement} launcher
		 */
		constructor(launcher) {
			this.launcher = launcher;
			this.param = {
				element: launcher.dataset.element,
				id: launcher.dataset.id,
				trackid: launcher.dataset.trackid,
				url: launcher.dataset.url,
				token: launcher.dataset.token,
			};
			this.groups = [];
			this.initialSelection = new Set();
			this.dialog = null;
			this.busy = false;
		}

		/**
		 * Current token: the one of the e-mail form if present
		 * @returns {string}
		 */
		getToken() {
			const input = document.querySelector('#mailform input[name="token"]');
			return input && input.value ? input.value : this.param.token;
		}

		open() {
			this.buildDialog();
			this.dialog.showModal();
			this.load();
		}

		buildDialog() {
			const dialog = document.createElement('dialog');
			dialog.className = 'attachments-modal';
			dialog.setAttribute('aria-labelledby', 'attachments-modal-title');
			dialog.innerHTML = `
				<div class="attachments-modal-content">
					<header class="attachments-modal-header">
						<div>
							<h3 id="attachments-modal-title" class="attachments-modal-title">${esc(t('ConfirmCancelAttachmentsTitle'))}</h3>
							<p class="attachments-modal-subtitle">${esc(t('AttachmentsPickerHelp'))}</p>
						</div>
						<button type="button" class="attachments-close" aria-label="${esc(t('AttachmentsCloseDialog'))}">&times;</button>
					</header>
					<div class="attachments-modal-toolbar" hidden>
						<input type="search" class="attachments-search" autocomplete="off" spellcheck="false"
							placeholder="${esc(t('AttachmentsSearchPlaceholder'))}" aria-label="${esc(t('AttachmentsSearchPlaceholder'))}">
						<span class="attachments-summary" aria-live="polite"></span>
					</div>
					<div class="attachments-modal-body" aria-live="polite"></div>
					<div class="attachments-modal-error" role="alert" hidden></div>
					<footer class="attachments-modal-actions">
						<button type="button" class="dialog-btn dialog-btn-secondary attachments-cancel">${esc(t('Cancel'))}</button>
						<button type="button" class="dialog-btn dialog-btn-primary attachments-apply" disabled>${esc(t('AttachmentsApplySelection'))}</button>
					</footer>
				</div>`;
			document.body.appendChild(dialog);
			this.dialog = dialog;

			this.body = dialog.querySelector('.attachments-modal-body');
			this.toolbar = dialog.querySelector('.attachments-modal-toolbar');
			this.search = dialog.querySelector('.attachments-search');
			this.summary = dialog.querySelector('.attachments-summary');
			this.error = dialog.querySelector('.attachments-modal-error');
			this.applyBtn = dialog.querySelector('.attachments-apply');

			const close = () => { if (!this.busy) dialog.close(); };
			dialog.querySelector('.attachments-close').addEventListener('click', close);
			dialog.querySelector('.attachments-cancel').addEventListener('click', close);
			dialog.addEventListener('cancel', (e) => { if (this.busy) e.preventDefault(); });
			dialog.addEventListener('close', () => { dialog.remove(); this.launcher.focus(); });

			this.search.addEventListener('input', () => this.filter());
			this.body.addEventListener('change', (e) => {
				if (e.target.matches('input[type="checkbox"]')) this.refreshCounters();
			});
			this.applyBtn.addEventListener('click', () => this.apply());
		}

		renderLoading() {
			this.toolbar.hidden = true;
			this.body.setAttribute('aria-busy', 'true');
			this.body.innerHTML = `<div class="attachments-state"><span class="fa fa-spinner fa-spin" aria-hidden="true"></span> ${esc(t('AttachmentsLoading'))}</div>`;
		}

		/**
		 * @param {string} message
		 */
		renderLoadError(message) {
			this.toolbar.hidden = true;
			this.body.removeAttribute('aria-busy');
			this.body.innerHTML = `
				<div class="attachments-state attachments-state--error">
					<p>${esc(message || t('AttachmentsLoadError'))}</p>
					<button type="button" class="dialog-btn dialog-btn-secondary attachments-retry">${esc(t('AttachmentsRetry'))}</button>
				</div>`;
			this.body.querySelector('.attachments-retry').addEventListener('click', () => this.load());
		}

		renderEmpty() {
			this.toolbar.hidden = true;
			this.body.removeAttribute('aria-busy');
			this.body.innerHTML = `
				<div class="attachments-state">
					<p><strong>${esc(t('AttachmentsNoFile'))}</strong></p>
					<p class="attachments-muted">${esc(t('AttachmentsNoFileHelp'))}</p>
				</div>`;
		}

		async load() {
			this.renderLoading();
			this.hideError();
			this.applyBtn.disabled = true;

			const query = new URLSearchParams({
				mode: 'list',
				element: this.param.element,
				id: this.param.id,
				trackid: this.param.trackid,
				token: this.getToken(),
			});

			let data;
			try {
				const response = await fetch(this.param.url + '?' + query.toString(), {credentials: 'same-origin', headers: {'Accept': 'application/json'}});
				data = await response.json().catch(() => null);
				if (!response.ok || !data || !data.success) {
					this.renderLoadError(data && data.message ? data.message : '');
					return;
				}
			} catch (e) {
				this.renderLoadError('');
				return;
			}

			this.groups = Array.isArray(data.groups) ? data.groups : [];
			if (!this.groups.length) {
				this.renderEmpty();
				return;
			}
			this.renderList();
		}

		renderList() {
			this.initialSelection = new Set();
			const groupCount = this.groups.length;

			const html = this.groups.map((group) => {
				let hasChecked = false;
				let hasCurrent = false;
				const refsHtml = group.refs.map((ref) => {
					if (ref.current) hasCurrent = true;
					const filesHtml = ref.files.map((file) => {
						if (file.checked) {
							hasChecked = true;
							this.initialSelection.add(file.md5);
						}
						return `
							<label class="attachments-file" data-search="${esc(String(file.name).toLowerCase())}">
								<input type="checkbox" value="${esc(file.md5)}" ${file.checked ? 'checked' : ''}>
								<span class="attachments-file-name">${esc(file.name)}</span>
							</label>`;
					}).join('');
					return `
						<div class="attachments-ref" data-search="${esc(String(ref.ref).toLowerCase())}">
							<div class="attachments-ref-title">
								<span>${esc(ref.ref)}</span>
								${ref.current ? `<span class="attachments-tag">${esc(t('AttachmentsCurrentDocument'))}</span>` : ''}
							</div>
							${filesHtml}
						</div>`;
				}).join('');

				const open = groupCount <= 2 || hasChecked || hasCurrent;
				return `
					<details class="attachments-group" ${open ? 'open' : ''}>
						<summary>
							<span class="attachments-group-label">${esc(group.label)}</span>
							<span class="attachments-count" title="${esc(t('AttachmentsSelectedOnTotalAvailable'))}"></span>
						</summary>
						<div class="attachments-group-body">${refsHtml}</div>
						<p class="attachments-group-nomatch attachments-muted" hidden>${esc(t('AttachmentsNoMatch'))}</p>
					</details>`;
			}).join('');

			this.body.removeAttribute('aria-busy');
			this.body.innerHTML = html + `<div class="attachments-state attachments-noresult" hidden></div>`;
			this.toolbar.hidden = false;
			this.refreshCounters();
			this.search.focus();
		}

		/**
		 * Filter on file name or ref (a matching ref shows all its files)
		 */
		filter() {
			const term = this.search.value.trim().toLowerCase();
			let total = 0;

			this.body.querySelectorAll('.attachments-group').forEach((group) => {
				let groupMatches = 0;
				group.querySelectorAll('.attachments-ref').forEach((ref) => {
					const refMatch = term !== '' && ref.dataset.search.includes(term);
					let refMatches = 0;
					ref.querySelectorAll('.attachments-file').forEach((file) => {
						const match = term === '' || refMatch || file.dataset.search.includes(term);
						file.hidden = !match;
						if (match) refMatches++;
					});
					ref.hidden = refMatches === 0;
					groupMatches += refMatches;
				});
				group.hidden = groupMatches === 0;
				if (term !== '' && groupMatches > 0) group.open = true;
				total += groupMatches;
			});

			const noResult = this.body.querySelector('.attachments-noresult');
			noResult.hidden = total > 0;
			noResult.textContent = total > 0 ? '' : t('AttachmentsNoResultFor', this.search.value.trim());
			this.refreshCounters();
		}

		/**
		 * @returns {string[]}
		 */
		getSelection() {
			return Array.from(this.body.querySelectorAll('.attachments-file input:checked')).map((input) => input.value);
		}

		refreshCounters() {
			let selected = 0;
			let total = 0;
			this.body.querySelectorAll('.attachments-group').forEach((group) => {
				const all = group.querySelectorAll('.attachments-file input').length;
				const checked = group.querySelectorAll('.attachments-file input:checked').length;
				selected += checked;
				total += all;
				const badge = group.querySelector('.attachments-count');
				badge.textContent = checked + ' / ' + all;
				badge.classList.toggle('attachments-count--active', checked > 0);
			});
			this.summary.textContent = t('AttachmentsSelectedSummary', selected, total);

			const selection = this.getSelection();
			const changed = selection.length !== this.initialSelection.size || selection.some((md5) => !this.initialSelection.has(md5));
			this.applyBtn.disabled = !changed || this.busy;
			this.applyBtn.title = changed ? '' : t('AttachmentsNoChange');
		}

		/**
		 * @param {string} message
		 */
		showError(message) {
			this.error.textContent = message;
			this.error.hidden = false;
		}

		hideError() {
			this.error.hidden = true;
			this.error.textContent = '';
		}

		/**
		 * @param {boolean} busy
		 */
		setBusy(busy) {
			this.busy = busy;
			this.dialog.classList.toggle('attachments-modal--busy', busy);
			this.body.querySelectorAll('input').forEach((input) => { input.disabled = busy; });
			this.applyBtn.innerHTML = busy
				? `<span class="fa fa-spinner fa-spin" aria-hidden="true"></span>&nbsp;${esc(t('AttachmentsApplying'))}`
				: esc(t('AttachmentsApplySelection'));
			if (!busy) this.refreshCounters();
			else this.applyBtn.disabled = true;
		}

		async apply() {
			if (this.busy) return;
			this.hideError();
			this.setBusy(true);

			const body = new FormData();
			body.append('token', this.getToken());
			body.append('mode', 'apply');
			body.append('element', this.param.element);
			body.append('id', this.param.id);
			body.append('trackid', this.param.trackid);
			const readonly = !document.getElementById('addedfile') && !document.querySelector('#mailform input.removedfile');
			body.append('readonly', readonly ? '1' : '0');
			this.getSelection().forEach((md5) => body.append('files[]', md5));

			let data;
			try {
				const response = await fetch(this.param.url, {method: 'POST', body, credentials: 'same-origin', headers: {'Accept': 'application/json'}});
				data = await response.json().catch(() => null);
				if (!response.ok || !data || !data.success) {
					this.setBusy(false);
					this.showError(data && data.message ? data.message : t('AttachmentsApplyError'));
					return;
				}
			} catch (e) {
				this.setBusy(false);
				this.showError(t('AttachmentsApplyError'));
				return;
			}

			replaceAttachedRows(data.attachedHtml || '');

			const parts = [];
			if (data.added > 0) parts.push(t('AttachmentsNbAdded', data.added));
			if (data.removed > 0) parts.push(t('AttachmentsNbRemoved', data.removed));
			if (parts.length && Dolibarr.tools.setEventMessage) {
				Dolibarr.tools.setEventMessage(parts.join(', '));
			}

			if (data.failed > 0) {
				// Keep the dialog open: reload the list (real state) and say what went wrong
				this.setBusy(false);
				await this.load();
				this.showError(data.failedMessage || t('AttachmentsApplyError'));
				return;
			}

			this.busy = false;
			this.dialog.close();
		}
	}

	const boot = async () => {
		const launcher = document.getElementById('attachments-launcher');
		if (!launcher || launcher.dataset.ready) return;
		launcher.dataset.ready = '1';
		placeLauncher(launcher);

		const hasContext = typeof window.Dolibarr === 'object' && Dolibarr.tools && Dolibarr.tools.langs;
		if (!hasContext) {
			launcher.addEventListener('click', legacySend);
			return;
		}

		try {
			for (const domain of LANG_DOMAINS) {
				await Dolibarr.tools.langs.load(domain);
			}
		} catch (e) {
			// Keys are shown instead of translations, the picker still works
		}

		bindRemoveButtons(launcher);
		launcher.addEventListener('click', () => new AttachmentsPicker(launcher).open());
	};

	if (typeof window.Dolibarr === 'object') {
		document.addEventListener('Dolibarr:Ready', boot, {once: true});
	}
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', boot, {once: true});
	} else {
		boot();
	}
})();
