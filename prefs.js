import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class DBusPulsePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: _('Settings'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        this._buildAppearanceGroup(page, settings);
        this._buildSourceGroup(page, settings);
    }

    _buildSourceGroup(page, settings) {
        const group = new Adw.PreferencesGroup({
            title: _('DBus source'),
            description: _('Session-bus service and property to watch. A rebuild happens on every change.'),
        });
        page.add(group);

        const busRow = new Adw.EntryRow({title: _('Bus name')});
        busRow.set_text(settings.get_string('bus-name'));
        settings.bind('bus-name', busRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        group.add(busRow);

        const pathRow = new Adw.EntryRow({title: _('Object path')});
        pathRow.set_text(settings.get_string('object-path'));
        settings.bind('object-path', pathRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        group.add(pathRow);

        const ifaceRow = new Adw.EntryRow({title: _('Interface name')});
        ifaceRow.set_text(settings.get_string('interface-name'));
        settings.bind('interface-name', ifaceRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        group.add(ifaceRow);

        const propRow = new Adw.EntryRow({title: _('Property name')});
        propRow.set_text(settings.get_string('property-name'));
        settings.bind('property-name', propRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        group.add(propRow);

        const triggerAdjustment = new Gtk.Adjustment({
            lower: 0,
            upper: 4294967295,
            step_increment: 1,
            value: settings.get_uint('trigger-value'),
        });
        const triggerRow = new Adw.SpinRow({
            title: _('Trigger value'),
            subtitle: _('Pulse starts when the property equals this unsigned integer.'),
            adjustment: triggerAdjustment,
        });
        settings.bind('trigger-value', triggerAdjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(triggerRow);
    }

    _buildAppearanceGroup(page, settings) {
        const group = new Adw.PreferencesGroup({
            title: _('Appearance'),
            description: _('How the pulse looks. Knobs below apply to the selected style.'),
        });
        page.add(group);

        const STYLES = ['solid', 'aurora'];
        const styleRow = new Adw.ComboRow({
            title: _('Style'),
            model: Gtk.StringList.new([_('Solid border'), _('Aurora glow')]),
        });
        const syncSelected = () => {
            const idx = Math.max(0, STYLES.indexOf(settings.get_string('style')));
            if (styleRow.selected !== idx)
                styleRow.selected = idx;
        };
        syncSelected();
        styleRow.connect('notify::selected', () => {
            settings.set_string('style', STYLES[styleRow.selected]);
        });
        // Follow external changes (dconf, another prefs window) too.
        settings.connect('changed::style', syncSelected);
        group.add(styleRow);

        // --- Solid border rows ---

        // CSS color string — kept as an entry row so users can paste rgba(), #rrggbb, etc.
        // A Gtk.ColorDialogButton would be nicer but wouldn't round-trip arbitrary CSS.
        const colorRow = new Adw.EntryRow({title: _('Border color (CSS)')});
        colorRow.set_text(settings.get_string('border-color'));
        settings.bind('border-color', colorRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        group.add(colorRow);

        const thicknessAdjustment = new Gtk.Adjustment({
            lower: 1,
            upper: 64,
            step_increment: 1,
            value: settings.get_uint('border-thickness'),
        });
        const thicknessRow = new Adw.SpinRow({
            title: _('Border thickness (px)'),
            adjustment: thicknessAdjustment,
        });
        settings.bind('border-thickness', thicknessAdjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(thicknessRow);

        const durationAdjustment = new Gtk.Adjustment({
            lower: 100,
            upper: 3000,
            step_increment: 50,
            value: settings.get_uint('pulse-duration'),
        });
        const durationRow = new Adw.SpinRow({
            title: _('Pulse duration (ms)'),
            subtitle: _('Length of one fade half-cycle.'),
            adjustment: durationAdjustment,
        });
        settings.bind('pulse-duration', durationAdjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(durationRow);

        // --- Aurora glow rows ---

        const glowWidthAdjustment = new Gtk.Adjustment({
            lower: 16,
            upper: 400,
            step_increment: 4,
            value: settings.get_uint('aurora-glow-width'),
        });
        const glowWidthRow = new Adw.SpinRow({
            title: _('Glow width (px)'),
            subtitle: _('How far the glow reaches into the screen.'),
            adjustment: glowWidthAdjustment,
        });
        settings.bind('aurora-glow-width', glowWidthAdjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(glowWidthRow);

        const flowAdjustment = new Gtk.Adjustment({
            lower: 1000,
            upper: 30000,
            step_increment: 250,
            value: settings.get_uint('aurora-flow-duration'),
        });
        const flowRow = new Adw.SpinRow({
            title: _('Flow duration (ms)'),
            subtitle: _('Time for the colors to travel once around the screen.'),
            adjustment: flowAdjustment,
        });
        settings.bind('aurora-flow-duration', flowAdjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(flowRow);

        const breathAdjustment = new Gtk.Adjustment({
            lower: 500,
            upper: 10000,
            step_increment: 100,
            value: settings.get_uint('aurora-breath-duration'),
        });
        const breathRow = new Adw.SpinRow({
            title: _('Breathing duration (ms)'),
            subtitle: _('One full bright-dim-bright cycle.'),
            adjustment: breathAdjustment,
        });
        settings.bind('aurora-breath-duration', breathAdjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(breathRow);

        // Only show the rows that apply to the selected style.
        const solidRows = [colorRow, thicknessRow, durationRow];
        const auroraRows = [glowWidthRow, flowRow, breathRow];
        const updateVisibility = () => {
            const aurora = settings.get_string('style') === 'aurora';
            for (const row of solidRows)
                row.visible = !aurora;
            for (const row of auroraRows)
                row.visible = aurora;
        };
        settings.connect('changed::style', updateVisibility);
        updateVisibility();
    }
}
