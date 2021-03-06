/******************************************************************************

    Nano Core 2 - An adblocker
    Copyright (C) 2018  Nano Core 2 contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <http://www.gnu.org/licenses/>.

*******************************************************************************

    Background script.

******************************************************************************/

"use strict";

/*****************************************************************************/

var nano = nano || {};

/*****************************************************************************/

nano.ub = window.__ublock__;

/*****************************************************************************/

nano.inject_force_scroll = (tab) => {
    const payload = {
        code: "* { overflow: auto !important; }",
        runAt: "document_start"
    };

    if (vAPI.supportsUserStylesheets)
        payload.cssOrigin = "user";

    vAPI.insertCSS(tab, payload);
};

nano.recompile_filters = () => {
    const on_done = () => {
        vAPI.app.restart();
    };

    vAPI.storage.set(
        {
            compiledMagic: -1,
            selfieMagic: -1
        },
        on_done
    );
};

/*****************************************************************************/

nano.enable_integration_filter = () => {
    if (nano.ub.selectedFilterLists.includes("nano-defender"))
        return true;

    if (nano.ub.loadingFilterLists)
        return false;
    if (nano.ub.selectedFilterLists.length < 10)
        return false;

    nano.ub.saveSelectedFilterLists(["nano-defender"], true);
    nano.ub.loadFilterLists();
    return true;
};

/*****************************************************************************/

nano.is_trusted_ext = (id) => {
    return (
        id === nano.defender_ext_id_chrome ||
        id === nano.defender_ext_id_edge
    );
};

nano.handle_public_api = (msg) => {
    if (typeof msg.data !== "string")
        return false;

    switch (msg.data) {
        case "Nano Defender Enabled":
            return nano.enable_integration_filter();

        default:
            return false;
    }
};

nAPI.add_public_api_handler(nano.is_trusted_ext, nano.handle_public_api);

/*****************************************************************************/

nano.privileged_filters = new Set([
    "nano-filters",
    "nano-annoyance",
    "nano-whitelist",
    "nano-defender"
]);

nano.privileged_assets_previx = "nanop-";

/*****************************************************************************/

nano.CompileFlag = function () {
    this.reset();
};

nano.CompileFlag.prototype.reset = function () {
    this.first_party = false;
    this.strip_whitelist = false; // For third party filters

    this.is_partial = false;
    this.is_privileged = false;
};

nano.CompileFlag.prototype.update = function (key) {
    this.first_party = (
        key === nano.ub.userFiltersPath ||
        key === nano.ub.nanoPartialUserFiltersPath
    );
    this.strip_whitelist = (
        !this.first_party &&
        nano.ub.userSettings.advancedUserEnabled &&
        nano.ub.hiddenSettings.nanoIgnoreThirdPartyWhitelist
    );

    this.is_partial = (
        key === nano.ub.nanoPartialUserFiltersPath
    );
    this.is_privileged = (
        nano.privileged_filters.has(key) ||
        (
            !this.first_party &&
            nano.ub.userSettings.advancedUserEnabled &&
            nano.ub.hiddenSettings.nanoMakeThirdPartyFiltersPrivileged
        ) ||
        (
            this.first_party &&
            nano.ub.userSettings.advancedUserEnabled &&
            nano.ub.hiddenSettings.nanoMakeUserFiltersPrivileged
        )
    );
};

/*****************************************************************************/

nano.cf = new nano.CompileFlag();

/*****************************************************************************/

nano.FilterLinter = function () {
    this.cache_key = "nano/cache/user-filters-linting-result";
    this.reset();
};

nano.FilterLinter.prototype.reset = function () {
    // IMPORTANT! Any change in this function must be reflected in cache_result
    // and restore_result

    // This flag will be set to true when a full user filters recompilation is
    // initiated
    this.changed = false;

    this.warnings = [];
    this.errors = [];

    // The first line is 0, when resetting, line number must be -1 so the first
    // line will have number 0
    this.line = -1;
};

/*****************************************************************************/

nano.FilterLinter.prototype.cache_result = function () {
    const payload = {
        warnings: this.warnings,
        errors: this.errors,

        line: this.line
    };

    const entry = {};
    entry[this.cache_key] = JSON.stringify(payload);

    vAPI.storage.set(entry);
};

nano.FilterLinter.prototype.restore_result = function () {
    vAPI.storage.get(this.cache_key, (result) => {
        if (this.changed)
            return;

        const payload = result[this.cache_key];
        if (!payload)
            return;

        try {
            result = JSON.parse(payload);
        } catch (err) {
            return;
        }

        if (result instanceof Object === false)
            return;

        if (Array.isArray(result.warnings))
            this.warnings = result.warnings;
        if (Array.isArray(result.errors))
            this.errors = result.errors;
        if (typeof result.line === "number")
            this.line = result.line;
    });
};

nano.FilterLinter.prototype.clear_result = function () {
    this.reset();
    vAPI.storage.remove(this.cache_key);
};

/*****************************************************************************/

// Maximum 100 errors and 100 warnings

nano.FilterLinter.prototype.error = function (message) {
    if (this.errors.length > 100) {
        return;
    } else if (this.errors.length === 100) {
        this.errors.push({
            row: this.line,
            type: "error",
            text: vAPI.i18n("nano_l_filter_aborted_e")
        });
        return;
    }

    this.errors.push({
        row: this.line,
        type: "error",
        text: message
    });
};

nano.FilterLinter.prototype.warn = function (message) {
    if (this.warnings.length > 100) {
        return;
    } else if (this.warnings.length === 100) {
        this.warnings.push({
            row: this.line,
            type: "warning",
            text: vAPI.i18n("nano_l_filter_aborted_w")
        });
        return;
    }

    this.warnings.push({
        row: this.line,
        type: "warning",
        text: message
    });
};

/*****************************************************************************/

nano.flintable = {
    // Resource existence check
    ResScriptInject: 0x0000,
    ResRedirect: 0x0001
};

nano.FilterLinter.prototype.lint = function (lintable, ...data) {
    if (!nano.cf.first_party)
        return;

    switch (lintable) {
        case nano.flintable.ResScriptInject:
            {
                let token = data[0];

                const i = token.indexOf(",");
                if (i !== -1)
                    token = token.substring(0, i);

                if (!nano.ub.redirectEngine.resources.has(token)) {
                    nano.flintw(
                        "nano_l_filter_resource_not_found",
                        ["{{res}}", token]
                    );
                }
            }
            break;

        case nano.flintable.ResRedirect:
            {
                const token = data[0];

                if (
                    token !== "none" &&
                    !nano.ub.redirectEngine.resources.has(token)
                ) {
                    nano.flintw(
                        "nano_l_filter_resource_not_found",
                        ["{{res}}", token]
                    );
                }
            }
            break;

        default:
            console.error("Unexpected lintable type:", lintable);
            return;
    }
};

/*****************************************************************************/

nano.fl = new nano.FilterLinter();
nano.fl.restore_result();

/*****************************************************************************/

nano.flint = (is_err, key, placeholders) => {
    if (!nano.cf.first_party)
        return;

    let msg = vAPI.i18n(key);
    for (const pair of placeholders)
        msg = msg.replace(...pair);

    if (is_err)
        nano.fl.error(msg);
    else
        nano.fl.warn(msg);
};

nano.flinte = (key, ...placeholders) => {
    nano.flint(true, key, placeholders);
};

nano.flintw = (key, ...placeholders) => {
    nano.flint(false, key, placeholders);
};

/*****************************************************************************/

nano.WhitelistLinter = function () {
    this.re_suspecious_re = /^\/[0-9a-zA-Z-_.]+\/$/;
    this.reset();
};

nano.WhitelistLinter.prototype.reset = function () {
    this.warnings = [];
};

/*****************************************************************************/

// Maximum 100 warnings

nano.WhitelistLinter.prototype.lint = function (line, num) {
    if (this.warnings.length > 100) {
        return;
    } else if (this.warnings.length === 100) {
        this.warnings.push({
            row: num,
            type: "warning",
            text: vAPI.i18n("nano_l_whitelist_aborted_w")
        });
        return;
    }

    if (this.re_suspecious_re.test(line)) {
        this.warnings.push({
            row: num,
            type: "warning",
            text: vAPI.i18n("nano_l_whitelist_suspecious_re")
        });
    }
};

/*****************************************************************************/

nano.wl = new nano.WhitelistLinter();

/*****************************************************************************/
