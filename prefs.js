import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import Gdk from 'gi://Gdk';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const STYLES = ['solid', 'aurora'];

// Schema defaults for a freshly-added entry. Kept in one place so a new
// signal matches the gschema <default>s exactly.
function defaultEntry() {
    return {
        id: GLib.uuid_string_random(),
        busName: '',
        objectPath: '',
        interfaceName: '',
        propertyName: '',
        triggerValue: 1,
        style: 'solid',
        borderColor: 'rgba(255, 200, 0, 0.95)',
        borderThickness: 8,
        pulseDuration: 700,
        auroraGlowWidth: 80,
        auroraFlowDuration: 5000,
        auroraBreathDuration: 2400,
    };
}

function styleLabel(style) {
    return style === 'aurora' ? _('Aurora glow') : _('Solid border');
}

// One-shot fold of the legacy flat keys into the 'signals' array. Mirrors the
// extension-side logic so opening prefs before the shell has migrated is safe.
// Guards on an empty array so it never double-seeds.
function migrateIfNeeded(settings) {
    if (settings.get_boolean('migrated'))
        return;

    let entries = [];
    try {
        const parsed = JSON.parse(settings.get_string('signals'));
        if (Array.isArray(parsed))
            entries = parsed;
    } catch (_e) {
        entries = [];
    }

    if (entries.length === 0) {
        const entry = {
            id: GLib.uuid_string_random(),
            busName: settings.get_string('bus-name'),
            objectPath: settings.get_string('object-path'),
            interfaceName: settings.get_string('interface-name'),
            propertyName: settings.get_string('property-name'),
            triggerValue: settings.get_uint('trigger-value'),
            style: settings.get_string('style'),
            borderColor: settings.get_string('border-color'),
            borderThickness: settings.get_uint('border-thickness'),
            pulseDuration: settings.get_uint('pulse-duration'),
            auroraGlowWidth: settings.get_uint('aurora-glow-width'),
            auroraFlowDuration: settings.get_uint('aurora-flow-duration'),
            auroraBreathDuration: settings.get_uint('aurora-breath-duration'),
        };
        settings.set_string('signals', JSON.stringify([entry]));
    }

    settings.set_boolean('migrated', true);
}

function loadEntries(settings) {
    try {
        const parsed = JSON.parse(settings.get_string('signals'));
        return Array.isArray(parsed) ? parsed : [];
    } catch (_e) {
        return [];
    }
}

export default class DBusPulsePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // Guard: the prefs process may open before the shell has migrated.
        migrateIfNeeded(settings);

        this._settings = settings;
        this._window = window;
        this._entries = loadEntries(settings);
        this._rows = [];
        this._dragIndex = null;

        const page = new Adw.PreferencesPage({
            title: _('Settings'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        this._listGroup = new Adw.PreferencesGroup({
            title: _('Watched signals'),
            description: _('Each entry watches one DBus property. Order is priority: the topmost entry wins. Drag rows (or use the arrows) to reorder; click a row to edit it.'),
        });
        page.add(this._listGroup);

        const addButton = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            tooltip_text: _('Add signal'),
            valign: Gtk.Align.CENTER,
        });
        addButton.add_css_class('flat');
        addButton.connect('clicked', () => this._addEntry());
        this._listGroup.set_header_suffix(addButton);

        this._refreshList();
    }

    // --- Persistence -----------------------------------------------------

    _persist() {
        this._settings.set_string('signals', JSON.stringify(this._entries));
    }

    // --- Array mutations -------------------------------------------------

    _addEntry() {
        const entry = defaultEntry();
        this._entries.push(entry);
        this._persist();
        this._refreshList();
        this._openEditor(entry);
    }

    _deleteEntry(entry) {
        const idx = this._entries.indexOf(entry);
        if (idx < 0)
            return;
        this._entries.splice(idx, 1);
        this._persist();
        this._refreshList();
    }

    // UI-agnostic reorder. DnD and the ↑/↓ buttons both call this, so swapping
    // the trigger is a one-liner. Removes `from`, re-inserts at `to`.
    _moveEntry(from, to) {
        const len = this._entries.length;
        if (from < 0 || from >= len)
            return;
        const target = Math.max(0, Math.min(to, len - 1));
        if (from === target)
            return;
        const [moved] = this._entries.splice(from, 1);
        this._entries.splice(target, 0, moved);
        this._persist();
        this._refreshList();
    }

    // --- List UI ---------------------------------------------------------

    _refreshList() {
        for (const row of this._rows)
            this._listGroup.remove(row);
        this._rows = [];

        if (this._entries.length === 0) {
            const empty = new Adw.ActionRow({
                title: _('No signals yet'),
                subtitle: _('Add one with the + button above.'),
            });
            this._listGroup.add(empty);
            this._rows.push(empty);
            return;
        }

        this._entries.forEach((entry, index) => {
            const row = this._buildEntryRow(entry, index);
            this._listGroup.add(row);
            this._rows.push(row);
        });
    }

    _buildEntryRow(entry, index) {
        const title = entry.propertyName || entry.busName || _('Untitled signal');
        const subtitleParts = [styleLabel(entry.style)];
        if (entry.busName)
            subtitleParts.push(entry.busName);

        const row = new Adw.ActionRow({
            title,
            subtitle: subtitleParts.join(' · '),
            activatable: true,
        });

        // Drag-handle affordance (DnD) as a prefix.
        const handle = new Gtk.Image({
            icon_name: 'list-drag-handle-symbolic',
            tooltip_text: _('Drag to reorder'),
        });
        handle.add_css_class('dim-label');
        row.add_prefix(handle);

        // Reliable reorder path: ↑/↓ buttons. Same move function as DnD.
        const upButton = new Gtk.Button({
            icon_name: 'go-up-symbolic',
            tooltip_text: _('Move up'),
            valign: Gtk.Align.CENTER,
            sensitive: index > 0,
        });
        upButton.add_css_class('flat');
        upButton.connect('clicked', () => this._moveEntry(index, index - 1));

        const downButton = new Gtk.Button({
            icon_name: 'go-down-symbolic',
            tooltip_text: _('Move down'),
            valign: Gtk.Align.CENTER,
            sensitive: index < this._entries.length - 1,
        });
        downButton.add_css_class('flat');
        downButton.connect('clicked', () => this._moveEntry(index, index + 1));

        row.add_suffix(upButton);
        row.add_suffix(downButton);

        row.connect('activated', () => this._openEditor(entry));

        this._attachDnd(row, index);
        return row;
    }

    // Row drag-and-drop reorder. NOTE: DnD on GtkListBox rows is finicky and
    // could not be exercised in a live GTK4 session here — needs runtime
    // verification. The ↑/↓ buttons are the guaranteed fallback and drive the
    // exact same _moveEntry function.
    _attachDnd(row, index) {
        const dragSource = new Gtk.DragSource({actions: Gdk.DragAction.MOVE});
        dragSource.connect('prepare', () => {
            this._dragIndex = index;
            const value = new GObject.Value();
            value.init(GObject.TYPE_INT);
            value.set_int(index);
            return Gdk.ContentProvider.new_for_value(value);
        });
        dragSource.connect('drag-begin', (source) => {
            const paintable = new Gtk.WidgetPaintable({widget: row});
            source.set_icon(paintable, 0, 0);
        });
        row.add_controller(dragSource);

        const dropTarget = Gtk.DropTarget.new(GObject.TYPE_INT, Gdk.DragAction.MOVE);
        dropTarget.connect('drop', (_target, value) => {
            const from = typeof value === 'number' ? value : this._dragIndex;
            this._dragIndex = null;
            if (from === null || from === undefined)
                return false;
            this._moveEntry(from, index);
            return true;
        });
        row.add_controller(dropTarget);
    }

    // --- Editor ----------------------------------------------------------

    _openEditor(entry) {
        // Adw surface differs across the libadwaita shipped with GNOME 49/50.
        // Prefer a NavigationView subpage; fall back to a PreferencesDialog.
        if (typeof this._window.push_subpage === 'function') {
            const navPage = this._buildEditorSubpage(entry);
            navPage.connect('hidden', () => this._refreshList());
            this._window.push_subpage(navPage);
        } else {
            const dialog = new Adw.PreferencesDialog();
            dialog.set_title(_('Edit signal'));
            dialog.connect('closed', () => this._refreshList());
            dialog.add(this._buildEditorContent(entry, () => dialog.close()));
            dialog.present(this._window);
        }
    }

    _buildEditorSubpage(entry) {
        const content = this._buildEditorContent(entry, () => {
            if (typeof this._window.pop_subpage === 'function')
                this._window.pop_subpage();
        });

        const toolbarView = new Adw.ToolbarView();
        toolbarView.add_top_bar(new Adw.HeaderBar());
        toolbarView.set_content(content);

        return new Adw.NavigationPage({
            title: _('Edit signal'),
            child: toolbarView,
        });
    }

    // Returns an Adw.PreferencesPage scoped to a single entry. Every field
    // handler mutates `entry` in place and persists the whole array; there is
    // no settings.bind (a JSON blob can't bind per-field).
    _buildEditorContent(entry, closeFn) {
        const editorPage = new Adw.PreferencesPage();

        const makeEntryRow = (title, key) => {
            const row = new Adw.EntryRow({title});
            row.set_text(String(entry[key] ?? ''));
            row.connect('changed', () => {
                entry[key] = row.get_text();
                this._persist();
            });
            return row;
        };

        const makeSpinRow = (title, key, {lower, upper, step, subtitle}) => {
            const adjustment = new Gtk.Adjustment({
                lower,
                upper,
                step_increment: step,
                value: Number(entry[key] ?? lower),
            });
            const props = {title, adjustment};
            if (subtitle)
                props.subtitle = subtitle;
            const row = new Adw.SpinRow(props);
            adjustment.connect('value-changed', () => {
                entry[key] = adjustment.get_value();
                this._persist();
            });
            return row;
        };

        // --- DBus source ---
        const sourceGroup = new Adw.PreferencesGroup({
            title: _('DBus source'),
            description: _('Session-bus service and property to watch.'),
        });
        editorPage.add(sourceGroup);

        sourceGroup.add(makeEntryRow(_('Bus name'), 'busName'));
        sourceGroup.add(makeEntryRow(_('Object path'), 'objectPath'));
        sourceGroup.add(makeEntryRow(_('Interface name'), 'interfaceName'));
        sourceGroup.add(makeEntryRow(_('Property name'), 'propertyName'));
        sourceGroup.add(makeSpinRow(_('Trigger value'), 'triggerValue', {
            lower: 0,
            upper: 4294967295,
            step: 1,
            subtitle: _('Pulse starts when the property equals this unsigned integer.'),
        }));

        // --- Appearance ---
        const appearanceGroup = new Adw.PreferencesGroup({
            title: _('Appearance'),
            description: _('How the pulse looks. Knobs below apply to the selected style.'),
        });
        editorPage.add(appearanceGroup);

        const styleRow = new Adw.ComboRow({
            title: _('Style'),
            model: Gtk.StringList.new([_('Solid border'), _('Aurora glow')]),
        });
        styleRow.selected = Math.max(0, STYLES.indexOf(entry.style));
        appearanceGroup.add(styleRow);

        // --- Solid border rows ---
        // CSS color string kept as an entry row so users can paste rgba(),
        // #rrggbb, etc. A color-dialog button wouldn't round-trip arbitrary CSS.
        const colorRow = makeEntryRow(_('Border color (CSS)'), 'borderColor');
        appearanceGroup.add(colorRow);

        const thicknessRow = makeSpinRow(_('Border thickness (px)'), 'borderThickness', {
            lower: 1,
            upper: 64,
            step: 1,
        });
        appearanceGroup.add(thicknessRow);

        const durationRow = makeSpinRow(_('Pulse duration (ms)'), 'pulseDuration', {
            lower: 100,
            upper: 3000,
            step: 50,
            subtitle: _('Length of one fade half-cycle.'),
        });
        appearanceGroup.add(durationRow);

        // --- Aurora glow rows ---
        const glowWidthRow = makeSpinRow(_('Glow width (px)'), 'auroraGlowWidth', {
            lower: 16,
            upper: 400,
            step: 4,
            subtitle: _('How far the glow reaches into the screen.'),
        });
        appearanceGroup.add(glowWidthRow);

        const flowRow = makeSpinRow(_('Flow duration (ms)'), 'auroraFlowDuration', {
            lower: 1000,
            upper: 30000,
            step: 250,
            subtitle: _('Time for the colors to travel once around the screen.'),
        });
        appearanceGroup.add(flowRow);

        const breathRow = makeSpinRow(_('Breathing duration (ms)'), 'auroraBreathDuration', {
            lower: 500,
            upper: 10000,
            step: 100,
            subtitle: _('One full bright-dim-bright cycle.'),
        });
        appearanceGroup.add(breathRow);

        // Only show the rows that apply to the selected style.
        const solidRows = [colorRow, thicknessRow, durationRow];
        const auroraRows = [glowWidthRow, flowRow, breathRow];
        const updateVisibility = () => {
            const aurora = entry.style === 'aurora';
            for (const row of solidRows)
                row.visible = !aurora;
            for (const row of auroraRows)
                row.visible = aurora;
        };
        styleRow.connect('notify::selected', () => {
            entry.style = STYLES[styleRow.selected];
            this._persist();
            updateVisibility();
        });
        updateVisibility();

        // --- Danger zone ---
        const dangerGroup = new Adw.PreferencesGroup();
        editorPage.add(dangerGroup);

        const deleteButton = new Gtk.Button({
            label: _('Delete this signal'),
            halign: Gtk.Align.CENTER,
            margin_top: 12,
        });
        deleteButton.add_css_class('destructive-action');
        deleteButton.add_css_class('pill');
        deleteButton.connect('clicked', () => {
            this._deleteEntry(entry);
            closeFn();
        });
        dangerGroup.add(deleteButton);

        return editorPage;
    }
}
