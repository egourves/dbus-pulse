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
            description: _('How the border looks and how fast it pulses.'),
        });
        page.add(group);

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
    }
}
