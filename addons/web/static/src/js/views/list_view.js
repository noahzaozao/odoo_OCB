
odoo.define('web.ListView', function (require) {
"use strict";

var core = require('web.core');
var data = require('web.data');
var DataExport = require('web.DataExport');
var formats = require('web.formats');
var common = require('web.list_common');
var Model = require('web.DataModel');
var pyeval = require('web.pyeval');
var session = require('web.session');
var Sidebar = require('web.Sidebar');
var utils = require('web.utils');
var View = require('web.View');
var $ = require('$');

var Class = core.Class;
var _t = core._t;
var _lt = core._lt;
var QWeb = core.qweb;
var list_widget_registry = core.list_widget_registry;

// Allowed decoration on the list's rows: bold, italic and bootstrap semantics classes
var row_decoration = [
    'decoration-bf',
    'decoration-it',
    'decoration-danger',
    'decoration-info',
    'decoration-muted',
    'decoration-primary',
    'decoration-success',
    'decoration-warning'
];

var ListView = View.extend( /** @lends instance.web.ListView# */ {
    _template: 'ListView',
    accesskey: 'L',
    icon: 'fa-list-ul',
    display_name: _lt('List'),
    defaults: {
        // records can be selected one by one
        'selectable': true,
        // list rows can be deleted
        'deletable': false,
        // whether the column headers should be displayed
        'header': true,
        // display addition button, with that label
        'addable': _lt("Create"),
        // whether the list view can be sorted, note that once a view has been
        // sorted it can not be reordered anymore
        'sortable': true,
        // whether the view rows can be reordered (via vertical drag & drop)
        'reorderable': true,
        'action_buttons': true,
        //whether the editable property of the view has to be disabled
        'disable_editable_mode': false,
    },
    view_type: 'tree',
    events: {
        'click thead th.oe_sortable[data-id]': 'sort_by_column'
    },
    /**
     * Core class for list-type displays.
     *
     * As a view, needs a number of view-related parameters to be correctly
     * instantiated, provides options and overridable methods for behavioral
     * customization.
     *
     * See constructor parameters and method documentations for information on
     * the default behaviors and possible options for the list view.
     *
     * @constructs instance.web.ListView
     * @extends instance.web.View
     *
     * @param parent parent object
     * @param {instance.web.DataSet} dataset the dataset the view should work with
     * @param {String} view_id the listview's identifier, if any
     * @param {Object} options A set of options used to configure the view
     * @param {Boolean} [options.selectable=true] determines whether view rows are selectable (e.g. via a checkbox)
     * @param {Boolean} [options.header=true] should the list's header be displayed
     * @param {Boolean} [options.deletable=true] are the list rows deletable
     * @param {void|String} [options.addable="New"] should the new-record button be displayed, and what should its label be. Use ``null`` to hide the button.
     * @param {Boolean} [options.sortable=true] is it possible to sort the table by clicking on column headers
     * @param {Boolean} [options.reorderable=true] is it possible to reorder list rows
     */
    init: function(parent, dataset, view_id, options) {
        var self = this;
        this._super(parent);
        this.set_default_options(_.extend({}, this.defaults, options || {}));
        this.dataset = dataset;
        this.model = dataset.model;
        this.view_id = view_id;
        this.previous_colspan = null;
        this.colors = null;
        this.fonts = null;

        this.columns = [];

        this.records = new common.Collection();

        this.set_groups(new (this.options.GroupsType)(this));

        if (this.dataset instanceof data.DataSetStatic) {
            this.groups.datagroup = new StaticDataGroup(this.dataset);
        } else {
            this.groups.datagroup = new DataGroup(
                this, this.model,
                dataset.get_domain(),
                dataset.get_context());
            this.groups.datagroup.sort = this.dataset._sort;
        }

        this.page = 0;
        this.records.bind('change', function (event, record, key) {
            if (!_(self.aggregate_columns).chain()
                    .pluck('name').contains(key).value()) {
                return;
            }
            self.compute_aggregates();
        });

        this.no_leaf = false;
        this.grouped = false;

        if (!this.options.$pager || !this.options.$pager.length) {
            this.options.$pager = false;
        }
        // the view's number of records per page (|| section)
        this._limit = (this.options.limit ||
                       this.defaults.limit ||
                       (this.getParent().action || {}).limit ||
                       80);
    },
    view_loading: function(r) {
        return this.load_list(r);
    },
    set_default_options: function (options) {
        this._super(options);
        _.defaults(this.options, {
            GroupsType: ListView.Groups,
            ListType: ListView.List
        });
    },
    /**
     * Set a custom Group construct as the root of the List View.
     *
     * @param {instance.web.ListView.Groups} groups
     */
    set_groups: function (groups) {
        var self = this;
        if (this.groups) {
            $(this.groups).unbind("selected deleted action row_link");
            delete this.groups;
        }

        this.groups = groups;
        $(this.groups).bind({
            'selected': function (e, ids, records, deselected) {
                self.do_select(ids, records, deselected);
            },
            'deleted': function (e, ids) {
                self.do_delete(ids);
            },
            'action': function (e, action_name, id, callback) {
                self.do_button_action(action_name, id, callback);
            },
            'row_link': function (e, id, dataset, view) {
                self.do_activate_record(dataset.index, id, dataset, view);
            }
        });
    },
    /**
     * View startup method, the default behavior is to set the ``oe_list``
     * class on its root element and to perform an RPC load call.
     *
     * @returns {$.Deferred} loading promise
     */
    start: function() {
        this.$el.addClass('oe_list o_list_view');
        return this._super();
    },
    /**
     * Computes and returns the classnames for the provided record (from the
     * ``@decoration`` attribute)
     *
     * @param {Record} record record for the current row
     * @returns {String} classnames
     */
    compute_decoration_classnames: function (record) {
        var classnames= '';
        var context = _.extend({}, record.attributes, {
            uid: session.uid,
            current_date: moment().format('YYYY-MM-DD')
            // TODO: time, datetime, relativedelta
        });

        _.each(this.decoration, function(expr, decoration) {
            if (py.PY_isTrue(py.evaluate(expr, context))) {
                classnames += ' ' + decoration.replace('decoration', 'text');
            }
        });
        return classnames;
    },
    /**
     * Called after loading the list view's description, sets up such things
     * as the view table's columns, renders the table itself and hooks up the
     * various table-level and row-level DOM events (action buttons, deletion
     * buttons, selection of records, [New] button, selection of a given
     * record, ...)
     *
     * Sets up the following:
     *
     * * Processes arch and fields to generate a complete field descriptor for each field
     * * Create the table itself and allocate visible columns
     * * Hook in the top-level (header) [New|Add] and [Delete] button
     * * Sets up showing/hiding the top-level [Delete] button based on records being selected or not
     * * Sets up event handlers for action buttons and per-row deletion button
     * * Hooks global callback for clicking on a row
     *
     * @param {Object} data wrapped fields_view_get result
     * @param {Object} data.fields_view fields_view_get result (processed)
     * @param {Object} data.fields_view.fields mapping of fields for the current model
     * @param {Object} data.fields_view.arch current list view descriptor
     * @param {Boolean} grouped Is the list view grouped
     */
    load_list: function(data) {
        var self = this;
        this.fields_view = data;
        this.name = "" + this.fields_view.arch.attrs.string;
        this._limit = parseInt(this.fields_view.arch.attrs.limit, 10) || this._limit;

        // Retrieve the decoration defined on the model's list view
        this.decoration = _.pick(this.fields_view.arch.attrs, function(value, key) {
            return row_decoration.indexOf(key) >= 0;
        });
        this.decoration = _.mapObject(this.decoration, function(value) {
            return py.parse(py.tokenize(value));
        });

        this.setup_columns(this.fields_view.fields, this.grouped);

        this.$el.html(QWeb.render(this._template, this));
        this.$el.addClass(this.fields_view.arch.attrs['class']);

        // Head hook
        // Selecting records
        this.$el.find('.oe_list_record_selector').click(function(){
            self.$el.find('.oe_list_record_selector input').prop('checked',
                self.$el.find('.oe_list_record_selector').prop('checked')  || false);
            var selection = self.groups.get_selection();
            $(self.groups).trigger(
                'selected', [selection.ids, selection.records]);
        });

        //Sort
        var default_order = this.fields_view.arch.attrs.default_order,
            unsorted = !this.dataset._sort.length;
        if (unsorted && default_order && !this.grouped) {
            this.dataset.set_sort(default_order.split(','));
        }

        if(this.dataset._sort.length){
            if(this.dataset._sort[0].indexOf('-') == -1){
                this.$el.find('th[data-id=' + this.dataset._sort[0] + ']').addClass("sortdown");
            }else {
                this.$el.find('th[data-id=' + this.dataset._sort[0].split('-')[1] + ']').addClass("sortup");
            }
        }
        this.trigger('list_view_loaded', data, this.grouped);
    },
    /**
     * Render the buttons according to the ListView.buttons template and
     * add listeners on it.
     * Set this.$buttons with the produced jQuery element
     * @param {jQuery} [$node] a jQuery node where the rendered buttons should be inserted
     * $node may be undefined, in which case the ListView inserts them into this.options.$buttons
     * or into a div of its template
     */
    render_buttons: function($node) {
        if (!this.$buttons) {
            this.$buttons = $(QWeb.render("ListView.buttons", {'widget': this}));

            this.$buttons.on('click', '.o_list_button_add', this.proxy('do_add_record'));

            $node = $node || this.options.$buttons;
            if ($node) {
                this.$buttons.appendTo($node);
            } else {
                this.$('.oe_list_buttons').replaceWith(this.$buttons);
            }
        }
    },
    /**
     * Instantiate and render the sidebar.
     * Sets this.sidebar
     * @param {jQuery} [$node] a jQuery node where the sidebar should be inserted
     * $node may be undefined, in which case the ListView inserts the sidebar in
     * this.options.$sidebar or in a div of its template
     **/
    render_sidebar: function($node) {
        if (!this.sidebar && this.options.sidebar) {
            this.sidebar = new Sidebar(this, {editable: this.is_action_enabled('edit')});
            if (this.fields_view.toolbar) {
                this.sidebar.add_toolbar(this.fields_view.toolbar);
            }
            this.sidebar.add_items('other', _.compact([
                { label: _t("Export"), callback: this.on_sidebar_export },
                this.fields_view.fields.active && {label: _t("Archive"), callback: this.do_archive_selected},
                this.fields_view.fields.active && {label: _t("Unarchive"), callback: this.do_unarchive_selected},
                this.is_action_enabled('delete') && { label: _t('Delete'), callback: this.do_delete_selected }
            ]));

            $node = $node || this.options.$sidebar || this.$('.oe_list_sidebar');
            this.sidebar.appendTo($node);

            // Hide the sidebar by default (it will be shown as soon as a record is selected)
            this.sidebar.do_hide();
        }
    },
    /**
     * Render the pager according to the ListView.pager template and add listeners on it.
     * Set this.$pager with the produced jQuery element
     * @param {jQuery} [$node] a jQuery node where the rendered pager should be inserted
     * $node may be undefined, in which case the ListView inserts the pager into this.options.$pager
     * or into a div of its template
     */
    render_pager: function($node) {
        if (!this.$pager && this.options.pager) {
            var self =  this;

            this.$pager = $(QWeb.render("ListView.pager", {'widget': self}));
            this.$pager
                .on('click', 'a[data-pager-action]', function () {
                    var $this = $(this);
                    var max_page_index = Math.ceil(self.dataset.size() / self._limit) - 1;
                    switch ($this.data('pager-action')) {
                        case 'first':
                            self.page = 0;
                            break;
                        case 'last':
                            self.page = max_page_index;
                            break;
                        case 'next':
                            self.page += 1;
                            break;
                        case 'previous':
                            self.page -= 1;
                            break;
                    }
                    if (self.page < 0) {
                        self.page = max_page_index;
                    } else if (self.page > max_page_index) {
                        self.page = 0;
                    }
                    self.reload_content();
                }).find('.oe_list_pager_state')
                    .click(function (e) {
                        e.stopPropagation();
                        var $this = $(this);

                        var $select = $('<select>')
                            .appendTo($this.empty())
                            .click(function (e) {e.stopPropagation();})
                            .append('<option value="80">80</option>' +
                                    '<option value="200">200</option>' +
                                    '<option value="500">500</option>' +
                                    '<option value="2000">2000</option>' +
                                    '<option value="NaN">' + _t("Unlimited") + '</option>')
                            .change(function () {
                                var val = parseInt($select.val(), 10);
                                self._limit = (isNaN(val) ? null : val);
                                self.page = 0;
                                self.reload_content();
                            }).blur(function() {
                                $(this).trigger('change');
                            })
                            .val(self._limit || 'NaN');
                    });
            this.configure_pager(this.dataset);

            $node = $node || this.options.$pager;
            if ($node) {
                this.$pager.appendTo($node);
            } else {
                this.$('.oe_list_pager').replaceWith(this.$pager);
            }
        }
    },
    sort_by_column: function (e) {
        e.stopPropagation();
        var $column = $(e.currentTarget);
        var col_name = $column.data('id');
        var field = this.fields_view.fields[col_name];
        // test whether the field is sortable
        if (field && !field.sortable) {
            return false;
        }
        this.dataset.sort(col_name);
        if($column.hasClass("sortdown") || $column.hasClass("sortup"))  {
            $column.toggleClass("sortup sortdown");
        } else {
            $column.addClass("sortdown");
        }
        $column.siblings('.oe_sortable').removeClass("sortup sortdown");

        this.reload_content();
    },
    /**
     * Configures the ListView pager based on the provided dataset's information
     *
     * Horrifying side-effect: sets the dataset's data on this.dataset?
     *
     * @param {instance.web.DataSet} dataset
     */
    configure_pager: function (dataset) {
        this.dataset.ids = dataset.ids;
        // Not exactly clean
        if (dataset._length) {
            this.dataset._length = dataset._length;
        }
        if (this.$pager) {
            if (this.grouped) {
                // page count is irrelevant on grouped page, replace by limit
                this.$pager.find('.oe-pager-buttons').hide();
                this.$pager.find('.oe_list_pager_state').text(this._limit || '∞');
            } else {
                var total = dataset.size();
                var limit = this._limit || total;
                this.$pager.find('.oe-pager-buttons').toggle(total > limit);
                this.$pager.find('.oe_pager_value').toggle(total !== 0);
                var spager = '-';
                if (total) {
                    var range_start = this.page * limit + 1;
                    var range_stop = range_start - 1 + limit;
                    if (this.records.length) {
                        range_stop = range_start - 1 + this.records.length;
                    }
                    if (range_stop > total) {
                        range_stop = total;
                    }
                    spager = _.str.sprintf(_t("%d-%d of %d"), range_start, range_stop, total);
                }

                this.$pager.find('.oe_list_pager_state').text(spager);
            }
        }
    },
    /**
     * Sets up the listview's columns: merges view and fields data, move
     * grouped-by columns to the front of the columns list and make them all
     * visible.
     *
     * @param {Object} fields fields_view_get's fields section
     * @param {Boolean} [grouped] Should the grouping columns (group and count) be displayed
     */
    setup_columns: function (fields, grouped) {
        this.columns.splice(0, this.columns.length);
        this.columns.push.apply(this.columns,
            _(this.fields_view.arch.children).map(function (field) {
                var id = field.attrs.name;
                return for_(id, fields[id], field);
        }));
        if (grouped) {
            this.columns.unshift(
                new ListView.MetaColumn('_group', _t("Group")));
        }

        this.visible_columns = _.filter(this.columns, function (column) {
            return column.invisible !== '1';
        });

        this.aggregate_columns = _(this.visible_columns).invoke('to_aggregate');
    },
    /**
     * Used to handle a click on a table row, if no other handler caught the
     * event.
     *
     * The default implementation asks the list view's view manager to switch
     * to a different view (by calling
     * :js:func:`~instance.web.ViewManager.on_mode_switch`), using the
     * provided record index (within the current list view's dataset).
     *
     * If the index is null, ``switch_to_record`` asks for the creation of a
     * new record.
     *
     * @param {Number|void} index the record index (in the current dataset) to switch to
     * @param {String} [view="page"] the view type to switch to
     */
    select_record:function (index, view) {
        view = view || index === null || index === undefined ? 'form' : 'form';
        this.dataset.index = index;
        _.delay(_.bind(function () {
            this.do_switch_view(view);
        }, this));
    },
    do_show: function () {
        this._super();
        if (this.sidebar) {
            // Hide the sidebar by default (will be shown once a record is selected)
            this.sidebar.do_hide();
        }
    },
    /**
     * Reloads the list view based on the current settings (dataset & al)
     *
     * @deprecated
     * @param {Boolean} [grouped] Should the list be displayed grouped
     * @param {Object} [context] context to send the server while loading the view
     */
    reload_view: function (grouped, context) {
        return this.load_view(context);
    },
    /**
     * re-renders the content of the list view
     *
     * @returns {$.Deferred} promise to content reloading
     */
    reload_content: synchronized(function () {
        var self = this;
        self.$el.find('.oe_list_record_selector').prop('checked', false);
        this.records.reset();
        var reloaded = $.Deferred();
        reloaded.then(function () {
            self.configure_pager(self.dataset);
        });
        this.$el.find('.oe_list_content').append(
            this.groups.render(function () {
                if (self.dataset.index === null) {
                    if (self.records.length) {
                        self.dataset.index = 0;
                    }
                } else if (self.dataset.index >= self.records.length) {
                    self.dataset.index = self.records.length ? 0 : null;
                }

                self.compute_aggregates();
                reloaded.resolve();
            }));
        this.do_push_state({
            page: this.page,
            limit: this._limit
        });
        return reloaded.promise();
    }),
    reload: function () {
        return this.reload_content();
    },
    reload_record: function (record) {
        var self = this;
        var fields = this.fields_view.fields;
        return this.dataset.read_ids(
            [record.get('id')],
            _.pluck(_(this.columns).filter(function (r) {
                    return r.tag === 'field';
                }), 'name'),
            {check_access_rule: true}
        ).then(function (records) {
            var values = records[0];
            if (!values) {
                self.records.remove(record);
                return;
            }
            // _.each is broken if a field "length" is present
            for (var key in values) {
                if (fields[key] && fields[key].type === 'many2many')
                    record.set(key + '__display', false, {silent: true});
                record.set(key, values[key], {silent: true});
            }
            record.trigger('change', record);

            /* When a record is reloaded, there is a rendering lag because of the addition/suppression of 
            a table row. Since the list view editable need to wait for the end of this rendering lag before
            computing the position of the editable fields, a 100ms delay is added. */
            var def = $.Deferred();
            setTimeout(function() {
                def.resolve(records);
            }, 100);
            return def;
        });
    },

    do_load_state: function(state, warm) {
        var reload = false;
        if (state.page && this.page !== state.page) {
            this.page = state.page;
            reload = true;
        }
        if (state.limit) {
            if (_.isString(state.limit)) {
                state.limit = null;
            }
            if (state.limit !== this._limit) {
                this._limit = state.limit;
                reload = true;
            }
        }
        if (reload) {
            this.reload_content();
        }
    },
    on_sidebar_export: function() {
        new DataExport(this, this.dataset).open();
    },
    /**
     * Handler for the result of eval_domain_and_context, actually perform the
     * searching
     *
     * @param {Object} results results of evaluating domain and process for a search
     */
    do_search: function (domain, context, group_by) {
        this.page = 0;
        this.groups.datagroup = new DataGroup(
            this, this.model, domain, context, group_by);
        this.groups.datagroup.sort = this.dataset._sort;

        if (_.isEmpty(group_by) && !context['group_by_no_leaf']) {
            group_by = null;
        }
        this.no_leaf = !!context['group_by_no_leaf'];
        this.grouped = !!group_by;

        return this.alive(this.load_view(context)).then(
            this.proxy('reload_content'));
    },
    /**
     * Handles the signal to delete lines from the records list
     *
     * @param {Array} ids the ids of the records to delete
     */
    do_delete: function (ids) {
        if (!(ids.length && confirm(_t("Do you really want to remove these records?")))) {
            return;
        }
        var self = this;
        return $.when(this.dataset.unlink(ids)).done(function () {
            _(ids).each(function (id) {
                self.records.remove(self.records.get(id));
            });
            // Hide the table if there is no more record in the dataset
            if (self.dataset.size() === 0) {
                self.no_result();
            } else {
                if (self.records.length === 0 && self.dataset.size() > 0) {
                    //Trigger previous manually to navigate to previous page,
                    //If all records are deleted on current page.
                    self.$pager.find('ul li:first a').trigger('click');
                } else if (self.dataset.size() === self._limit) {
                    //Reload listview to update current page with next page records
                    //because pager going to be hidden if dataset.size == limit
                    self.reload();
                } else {
                    self.configure_pager(self.dataset);
                }
            }
            self.compute_aggregates();
        });
    },
    /**
     * Handles the signal indicating that a new record has been selected
     *
     * @param {Array} ids selected record ids
     * @param {Array} records selected record values
     */
    do_select: function (ids, records, deselected) {
        // uncheck header hook if at least one row has been deselected
        if (deselected) {
            this.$('.oe_list_record_selector').prop('checked', false);
        }

        if (!ids.length) {
            this.dataset.index = 0;
            if (this.sidebar) {
                this.sidebar.do_hide();
            }
            this.compute_aggregates();
            return;
        }

        this.dataset.index = _(this.dataset.ids).indexOf(ids[0]);
        if (this.sidebar) {
            this.sidebar.do_show();
        }

        this.compute_aggregates(_(records).map(function (record) {
            return {count: 1, values: record};
        }));
    },
    /**
     * Handles action button signals on a record
     *
     * @param {String} name action name
     * @param {Object} id id of the record the action should be called on
     * @param {Function} callback should be called after the action is executed, if non-null
     */
    do_button_action: function (name, id, callback) {
        this.handle_button(name, id, callback);
    },
    /**
     * Base handling of buttons, can be called when overriding do_button_action
     * in order to bypass parent overrides.
     *
     * The callback will be provided with the ``id`` as its parameter, in case
     * handle_button's caller had to alter the ``id`` (or even create one)
     * while not being ``callback``'s creator.
     *
     * This method should not be overridden.
     *
     * @param {String} name action name
     * @param {Object} id id of the record the action should be called on
     * @param {Function} callback should be called after the action is executed, if non-null
     */
    handle_button: function (name, id, callback) {
        var action = _.detect(this.columns, function (field) {
            return field.name === name;
        });
        if (!action) { return; }
        action = $.extend(true, {}, action);
        if ('confirm' in action && !window.confirm(action.confirm)) {
            return;
        }

        var c = new data.CompoundContext();
        c.set_eval_context(_.extend({
            active_id: id,
            active_ids: [id],
            active_model: this.dataset.model
        }, this.records.get(id).toContext()));
        if (action.context) {
            c.add(action.context);
        }
        action.context = c;
        this.do_execute_action(
            action, this.dataset, id, _.bind(callback, null, id));
    },
    /**
     * Handles the activation of a record (clicking on it)
     *
     * @param {Number} index index of the record in the dataset
     * @param {Object} id identifier of the activated record
     * @param {instance.web.DataSet} dataset dataset in which the record is available (may not be the listview's dataset in case of nested groups)
     */
    do_activate_record: function (index, id, dataset, view) {
        this.dataset.ids = dataset.ids;
        this.select_record(index, view);
    },
    /**
     * Handles signal for the addition of a new record (can be a creation,
     * can be the addition from a remote source, ...)
     *
     * The default implementation is to switch to a new record on the form view
     */
    do_add_record: function () {
        this.select_record(null);
    },
    /**
     * Handles deletion of all selected lines
     */
    do_delete_selected: function () {
        var ids = this.groups.get_selection().ids;
        if (ids.length) {
            this.do_delete(this.groups.get_selection().ids);
        } else {
            this.do_warn(_t("Warning"), _t("You must select at least one record."));
        }
    },
    /**
     * Handles archiving/unarchiving of selected lines
     */
    do_archive_selected: function () {
        var records = this.groups.get_selection().records;
        this.do_archive(records, true);
    },
    do_unarchive_selected: function () {
        var records = this.groups.get_selection().records;
        this.do_archive(records, false);
    },
    do_archive: function (records, archive) {
        var active_value = !archive;
        var record_ids = [];
        _.each(records, function(record) {
            if (record.active != active_value) {
                record_ids.push(record.id);
            }
        });
        if (record_ids.length) {
            this.dataset.call('write', [record_ids, {active: active_value}])
                        .done(_.bind(this.reload, this));
        }
    },
    /**
     * Computes the aggregates for the current list view, either on the
     * records provided or on the records of the internal
     * :js:class:`~instance.web.ListView.Group`, by calling
     * :js:func:`~instance.web.ListView.group.get_records`.
     *
     * Then displays the aggregates in the table through
     * :js:method:`~instance.web.ListView.display_aggregates`.
     *
     * @param {Array} [records]
     */
    compute_aggregates: function (records) {
        var columns = _(this.aggregate_columns).filter(function (column) {
            return column['function']; });
        if (_.isEmpty(columns)) { return; }

        if (_.isEmpty(records)) {
            records = this.groups.get_records();
        }
        records = _(records).compact();

        var count = 0, sums = {};
        _(columns).each(function (column) {
            switch (column['function']) {
                case 'max':
                    sums[column.id] = -Infinity;
                    break;
                case 'min':
                    sums[column.id] = Infinity;
                    break;
                default:
                    sums[column.id] = 0;
            }
        });
        _(records).each(function (record) {
            count += record.count || 1;
            _(columns).each(function (column) {
                var field = column.id,
                    value = record.values[field];
                switch (column['function']) {
                    case 'sum':
                        sums[field] += value;
                        break;
                    case 'avg':
                        sums[field] += record.count * value;
                        break;
                    case 'min':
                        if (sums[field] > value) {
                            sums[field] = value;
                        }
                        break;
                    case 'max':
                        if (sums[field] < value) {
                            sums[field] = value;
                        }
                        break;
                }
            });
        });

        var aggregates = {};
        _(columns).each(function (column) {
            var field = column.id;
            switch (column['function']) {
                case 'avg':
                    aggregates[field] = {value: sums[field] / count};
                    break;
                default:
                    aggregates[field] = {value: sums[field]};
            }
        });

        this.display_aggregates(aggregates);
    },
    display_aggregates: function (aggregation) {
        var $footer_cells = this.$el.find('.oe_list_footer');
        _(this.aggregate_columns).each(function (column) {
            if (!column['function']) {
                return;
            }

            $footer_cells.filter(_.str.sprintf('[data-field=%s]', column.id))
                .html(column.format(aggregation, { process_modifiers: false }));
        });
    },
    get_selected_ids: function() {
        var ids = this.groups.get_selection().ids;
        return ids;
    },
    /**
     * Calculate the active domain of the list view. This should be done only
     * if the header checkbox has been checked. This is done by evaluating the
     * search results, and then adding the dataset domain (i.e. action domain).
     */
    get_active_domain: function () {
        var self = this;
        if (this.$('.oe_list_record_selector').prop('checked')) {
            var search_view = this.getParent().searchview;
            var search_data = search_view.build_search_data();
            return pyeval.eval_domains_and_contexts({
                domains: search_data.domains,
                contexts: search_data.contexts,
                group_by_seq: search_data.groupbys || []
            }).then(function (results) {
                var domain = self.dataset.domain.concat(results.domain || []);
                return domain;
            });
        }
        else {
            return $.Deferred().resolve();
        }
    },
    /**
     * Adds padding columns at the start or end of all table rows (including
     * field names row)
     *
     * @param {Number} count number of columns to add
     * @param {Object} options
     * @param {"before"|"after"} [options.position="after"] insertion position for the new columns
     * @param {Object} [options.except] content row to not pad
     */
    pad_columns: function (count, options) {
        options = options || {};
        // padding for action/pager header
        var $first_header = this.$el.find('thead tr:first th');
        var colspan = $first_header.attr('colspan');
        if (colspan) {
            if (!this.previous_colspan) {
                this.previous_colspan = colspan;
            }
            $first_header.attr('colspan', parseInt(colspan, 10) + count);
        }
        // Padding for column titles, footer and data rows
        var $rows = this.$el
                .find('.oe_list_header_columns, tr:not(thead tr)')
                .not(options['except']);
        var newcols = new Array(count+1).join('<td class="oe_list_padding"></td>');
        if (options.position === 'before') {
            $rows.prepend(newcols);
        } else {
            $rows.append(newcols);
        }
    },
    /**
     * Removes all padding columns of the table
     */
    unpad_columns: function () {
        this.$el.find('.oe_list_padding').remove();
        if (this.previous_colspan) {
            this.$el
                    .find('thead tr:first th')
                    .attr('colspan', this.previous_colspan);
            this.previous_colspan = null;
        }
    },
    no_result: function () {
        this.$el.find('.oe_view_nocontent').remove();
        if (this.groups.group_by
            || !this.options.action
            || !this.options.action.help) {
            return;
        }
        this.$el.find('table:first').hide();
        this.$el.prepend(
            $('<div class="oe_view_nocontent">').html(this.options.action.help)
        );
        if (this.$buttons) {
            var $buttons = this.$buttons;
            this.$el.find('.oe_view_nocontent').click(function() {
                $buttons.width($buttons.width() + 1).openerpBounce();
            });
        }
    }
});
core.view_registry.add('list', ListView);

ListView.List = Class.extend( /** @lends instance.web.ListView.List# */{
    /**
     * List display for the ListView, handles basic DOM events and transforms
     * them in the relevant higher-level events, to which the list view (or
     * other consumers) can subscribe.
     *
     * Events on this object are registered via jQuery.
     *
     * Available events:
     *
     * `selected`
     *   Triggered when a row is selected (using check boxes), provides an
     *   array of ids of all the selected records.
     * `deleted`
     *   Triggered when deletion buttons are hit, provide an array of ids of
     *   all the records being marked for suppression.
     * `action`
     *   Triggered when an action button is clicked, provides two parameters:
     *
     *   * The name of the action to execute (as a string)
     *   * The id of the record to execute the action on
     * `row_link`
     *   Triggered when a row of the table is clicked, provides the index (in
     *   the rows array) and id of the selected record to the handle function.
     *
     * @constructs instance.web.ListView.List
     * @extends instance.web.Class
     * 
     * @param {Object} opts display options, identical to those of :js:class:`instance.web.ListView`
     */
    init: function (group, opts) {
        var self = this;
        this.group = group;
        this.view = group.view;
        this.session = this.view.session;

        this.options = opts.options;
        this.columns = opts.columns;
        this.dataset = opts.dataset;
        this.records = opts.records;

        this.record_callbacks = {
            'remove': function (event, record) {
                var id = record.get('id');
                self.dataset.remove_ids([id]);
                var $row = self.$current.children('[data-id=' + id + ']');
                var index = $row.data('index');
                $row.remove();
            },
            'reset': function () { return self.on_records_reset(); },
            'change': function (event, record, attribute, value, old_value) {
                var $row;
                if (attribute === 'id') {
                    if (old_value) {
                        throw new Error(_.str.sprintf( _t("Setting 'id' attribute on existing record %s"),
                            JSON.stringify(record.attributes) ));
                    }
                    self.dataset.add_ids([value], self.records.indexOf(record));
                    // Set id on new record
                    $row = self.$current.children('[data-id=false]');
                } else {
                    $row = self.$current.children(
                        '[data-id=' + record.get('id') + ']');
                }

                var $newRow = $(self.render_record(record));
                $newRow.find('.oe_list_record_selector input').prop('checked', !!$row.find('.oe_list_record_selector input').prop('checked'));
                $row.replaceWith($newRow);
            },
            'add': function (ev, records, record, index) {
                var $new_row = $(self.render_record(record));
                var id = record.get('id');
                if (id) { self.dataset.add_ids([id], index); }

                if (index === 0) {
                    $new_row.prependTo(self.$current);
                } else {
                    var previous_record = records.at(index-1),
                        $previous_sibling = self.$current.children(
                                '[data-id=' + previous_record.get('id') + ']');
                    $new_row.insertAfter($previous_sibling);
                }
            }
        };
        _(this.record_callbacks).each(function (callback, event) {
            this.records.bind(event, callback);
        }, this);

        this.$current = $('<tbody>')
            .delegate('input[readonly=readonly]', 'click', function (e) {
                /*
                    Against all logic and sense, as of right now @readonly
                    apparently does nothing on checkbox and radio inputs, so
                    the trick of using @readonly to have, well, readonly
                    checkboxes (which still let clicks go through) does not
                    work out of the box. We *still* need to preventDefault()
                    on the event, otherwise the checkbox's state *will* toggle
                    on click
                 */
                e.preventDefault();
            })
            .delegate('th.oe_list_record_selector', 'click', function (e) {
                e.stopPropagation();
                var selection = self.get_selection();
                var checked = $(e.currentTarget).find('input').prop('checked');
                $(self).trigger(
                        'selected', [selection.ids, selection.records, ! checked]);
            })
            .delegate('td.oe_list_record_delete', 'click', function (e) {
                e.stopPropagation();
                var $row = $(e.target).closest('tr');
                $(self).trigger('deleted', [[self.row_id($row)]]);
                // IE Edge go crazy when we use confirm dialog and remove the focused element
                if(document.hasFocus && !document.hasFocus()) {
                    $('<input />').appendTo('body').focus().remove();
                }
            })
            .delegate('td.oe_list_field_cell button', 'click', function (e) {
                e.stopPropagation();
                var $target = $(e.currentTarget),
                      field = $target.closest('td').data('field'),
                       $row = $target.closest('tr'),
                  record_id = self.row_id($row);
                
                if ($target.attr('disabled')) {
                    return;
                }
                $target.attr('disabled', 'disabled');

                // note: $.data converts data to number if it's composed only
                // of digits, nice when storing actual numbers, not nice when
                // storing strings composed only of digits. Force the action
                // name to be a string
                $(self).trigger('action', [field.toString(), record_id, function (id) {
                    $target.removeAttr('disabled');
                    return self.reload_record(self.records.get(id));
                }]);
            })
            .delegate('a', 'click', function (e) {
                e.stopPropagation();
            })
            .delegate('tr', 'click', function (e) {
                var row_id = self.row_id(e.currentTarget);
                if (row_id) {
                    e.stopPropagation();
                    if (!self.dataset.select_id(row_id)) {
                        throw new Error(_t("Could not find id in dataset"));
                    }
                    self.row_clicked(e);
                }
            });
    },
    row_clicked: function (e, view) {
        $(this).trigger(
            'row_link',
            [this.dataset.ids[this.dataset.index],
             this.dataset, view]);
    },
    render_cell: function (record, column) {
        var value;
        if(column.type === 'reference') {
            value = record.get(column.id);
            var ref_match;
            // Ensure that value is in a reference "shape", otherwise we're
            // going to loop on performing name_get after we've resolved (and
            // set) a human-readable version. m2o does not have this issue
            // because the non-human-readable is just a number, where the
            // human-readable version is a pair
            if (value && (ref_match = /^([\w\.]+),(\d+)$/.exec(value))) {
                // reference values are in the shape "$model,$id" (as a
                // string), we need to split and name_get this pair in order
                // to get a correctly displayable value in the field
                var model = ref_match[1],
                    id = parseInt(ref_match[2], 10);
                new data.DataSet(this.view, model).name_get([id]).done(function(names) {
                    if (!names.length) { return; }
                    record.set(column.id + '__display', names[0][1]);
                });
            }
        } else if (column.type === 'many2one') {
            value = record.get(column.id);
            // m2o values are usually name_get formatted, [Number, String]
            // pairs, but in some cases only the id is provided. In these
            // cases, we need to perform a name_get call to fetch the actual
            // displayable value
            if (typeof value === 'number' || value instanceof Number) {
                // fetch the name, set it on the record (in the right field)
                // and let the various registered events handle refreshing the
                // row
                new data.DataSet(this.view, column.relation)
                        .name_get([value]).done(function (names) {
                    if (!names.length) { return; }
                    record.set(column.id, names[0]);
                });
            }
        } else if (column.type === 'many2many') {
            value = record.get(column.id);
            // non-resolved (string) m2m values are arrays
            if (value instanceof Array && !_.isEmpty(value)
                    && !record.get(column.id + '__display')) {
                var ids;
                // they come in two shapes:
                if (value[0] instanceof Array) {
                    _.each(value, function(command) {
                        switch (command[0]) {
                            case 4: ids.push(command[1]); break;
                            case 5: ids = []; break;
                            case 6: ids = command[2]; break;
                            default: throw new Error(_.str.sprintf( _t("Unknown m2m command %s"), command[0]));
                        }
                    });
                } else {
                    // 2. an array of ids
                    ids = value;
                }
                new Model(column.relation)
                    .call('name_get', [ids, this.dataset.get_context()]).done(function (names) {
                        // FIXME: nth horrible hack in this poor listview
                        record.set(column.id + '__display',
                                   _(names).pluck(1).join(', '));
                        record.set(column.id, ids);
                    });
                // temporary empty display name
                record.set(column.id + '__display', false);
            }
        }
        return column.format(record.toForm().data, {
            model: this.dataset.model,
            id: record.get('id')
        });
    },
    render: function () {
        var self = this;
        this.$current.html(
            QWeb.render('ListView.rows', _.extend({}, this, {
                    render_cell: function () {
                        return self.render_cell.apply(self, arguments); }
                })));
        this.pad_table_to(4);
    },
    pad_table_to: function (count) {
        if (this.records.length >= count ||
                _(this.columns).any(function(column) { return column.meta; })) {
            return;
        }
        var cells = [];
        if (this.options.selectable) {
            cells.push('<th class="oe_list_record_selector"></td>');
        }
        _(this.columns).each(function(column) {
            if (column.invisible === '1') {
                return;
            }
            cells.push('<td title="' + column.string + '">&nbsp;</td>');
        });
        if (this.options.deletable) {
            cells.push('<td class="oe_list_record_delete"></td>');
        }
        cells.unshift('<tr>');
        cells.push('</tr>');

        var row = cells.join('');
        this.$current
            .children('tr:not([data-id])').remove().end()
            .append(new Array(count - this.records.length + 1).join(row));
    },
    /**
     * Gets the ids of all currently selected records, if any
     * @returns {Object} object with the keys ``ids`` and ``records``, holding respectively the ids of all selected records and the records themselves.
     */
    get_selection: function () {
        var result = {ids: [], records: []};
        if (!this.options.selectable) {
            return result;
        }
        var records = this.records;
        this.$current.find('th.oe_list_record_selector input:checked')
                .closest('tr').each(function () {
            var record = records.get($(this).data('id'));
            result.ids.push(record.get('id'));
            result.records.push(record.attributes);
        });
        return result;
    },
    /**
     * Returns the identifier of the object displayed in the provided table
     * row
     *
     * @param {Object} row the selected table row
     * @returns {Number|String} the identifier of the row's object
     */
    row_id: function (row) {
        return $(row).data('id');
    },
    /**
     * Death signal, cleans up list display
     */
    on_records_reset: function () {
        _(this.record_callbacks).each(function (callback, event) {
            this.records.unbind(event, callback);
        }, this);
        if (!this.$current) { return; }
        this.$current.remove();
    },
    get_records: function () {
        return this.records.map(function (record) {
            return {count: 1, values: record.attributes};
        });
    },
    /**
     * Reloads the provided record by re-reading its content from the server.
     *
     * @param {Record} record
     * @returns {$.Deferred} promise to the finalization of the reloading
     */
    reload_record: function (record) {
        return this.view.reload_record(record);
    },
    /**
     * Renders a list record to HTML
     *
     * @param {Record} record index of the record to render in ``this.rows``
     * @returns {String} QWeb rendering of the selected record
     */
    render_record: function (record) {
        var self = this;
        var index = this.records.indexOf(record);
        return QWeb.render('ListView.row', {
            columns: this.columns,
            options: this.options,
            record: record,
            row_parity: (index % 2 === 0) ? 'even' : 'odd',
            view: this.view,
            render_cell: function () {
                return self.render_cell.apply(self, arguments); }
        });
    }
});

ListView.Groups = Class.extend( /** @lends instance.web.ListView.Groups# */{
    passthrough_events: 'action deleted row_link',
    /**
     * Grouped display for the ListView. Handles basic DOM events and interacts
     * with the :js:class:`~DataGroup` bound to it.
     *
     * Provides events similar to those of
     * :js:class:`~instance.web.ListView.List`
     *
     * @constructs instance.web.ListView.Groups
     * @extends instance.web.Class
     *
     * @param {instance.web.ListView} view
     * @param {Object} [options]
     * @param {Collection} [options.records]
     * @param {Object} [options.options]
     * @param {Array} [options.columns]
     */
    init: function (view, options) {
        options = options || {};
        this.view = view;
        this.records = options.records || view.records;
        this.options = options.options || view.options;
        this.columns = options.columns || view.columns;
        this.datagroup = null;

        this.$row = null;
        this.children = {};

        this.page = 0;

        var self = this;
        this.records.bind('reset', function () {
            return self.on_records_reset(); });
    },
    make_fragment: function () {
        return document.createDocumentFragment();
    },
    /**
     * Returns a DOM node after which a new tbody can be inserted, so that it
     * follows the provided row.
     *
     * Necessary to insert the result of a new group or list view within an
     * existing groups render, without losing track of the groups's own
     * elements
     *
     * @param {HTMLTableRowElement} row the row after which the caller wants to insert a body
     * @returns {HTMLTableSectionElement} element after which a tbody can be inserted
     */
    point_insertion: function (row) {
        var $row = $(row);
        var red_letter_tboday = $row.closest('tbody')[0];

        var $next_siblings = $row.nextAll();
        if ($next_siblings.length) {
            var $root_kanal = $('<tbody>').insertAfter(red_letter_tboday);

            $root_kanal.append($next_siblings);
            this.elements.splice(
                _.indexOf(this.elements, red_letter_tboday),
                0,
                $root_kanal[0]);
        }
        return red_letter_tboday;
    },
    make_paginator: function () {
        var self = this;
        var $prev = $('<button type="button" data-pager-action="previous">&lt;</button>')
            .click(function (e) {
                e.stopPropagation();
                if (self.page > 0) {
                    self.page -= 1;
                } else {
                    self.page = self.max_page_index;
                }

                self.$row.closest('tbody').next()
                    .replaceWith(self.render());
            });
        var $next = $('<button type="button" data-pager-action="next">&gt;</button>')
            .click(function (e) {
                e.stopPropagation();
                if (self.page < self.max_page_index) {
                    self.page += 1;
                } else {
                    self.page = 0;
                }

                self.$row.closest('tbody').next()
                    .replaceWith(self.render());
            });
        this.$row.children().last()
            .addClass('oe_list_group_pagination')
            .append($prev)
            .append('<span class="oe_list_pager_state"></span>')
            .append($next);
    },
    open: function (point_insertion) {
        this.render().insertAfter(point_insertion);

        var no_subgroups = _(this.datagroup.group_by).isEmpty(),
            records_terminated = !this.datagroup.context['group_by_no_leaf'];
        if (no_subgroups && records_terminated) {
            this.make_paginator();
        }
    },
    close: function () {
        this.$row.children().last().find('button').remove();
        this.$row.children().last().find('span').remove();
        this.records.reset();
    },
    /**
     * Prefixes ``$node`` with floated spaces in order to indent it relative
     * to its own left margin/baseline
     *
     * @param {jQuery} $node jQuery object to indent
     * @param {Number} level current nesting level, >= 1
     * @returns {jQuery} the indentation node created
     */
    indent: function ($node, level) {
        return $('<span>')
                .css({'float': 'left', 'white-space': 'pre'})
                .text(new Array(level).join('   '))
                .prependTo($node);
    },
    render_groups: function (datagroups) {
        var self = this;
        var placeholder = this.make_fragment();
        _(datagroups).each(function (group) {
            if (self.children[group.value]) {
                self.records.proxy(group.value).reset();
                delete self.children[group.value];
            }
            var child = self.children[group.value] = new (self.view.options.GroupsType)(self.view, {
                records: self.records.proxy(group.value),
                options: self.options,
                columns: self.columns
            });
            self.bind_child_events(child);
            child.datagroup = group;

            var $row = child.$row = $('<tr class="oe_group_header">');
            if (group.openable && group.length) {
                $row.click(function (e) {
                    if (!$row.data('open')) {
                        $row.data('open', true)
                            .find('span.ui-icon')
                                .removeClass('ui-icon-triangle-1-e')
                                .addClass('ui-icon-triangle-1-s');
                        child.open(self.point_insertion(e.currentTarget));
                    } else {
                        $row.removeData('open')
                            .find('span.ui-icon')
                                .removeClass('ui-icon-triangle-1-s')
                                .addClass('ui-icon-triangle-1-e');
                        child.close();
                        // force recompute the selection as closing group reset properties
                        var selection = self.get_selection();
                        $(self).trigger('selected', [selection.ids, this.records]);
                    }
                });
            }
            placeholder.appendChild($row[0]);

            var $group_column = $('<th class="oe_list_group_name">').appendTo($row);
            // Don't fill this if group_by_no_leaf but no group_by
            if (group.grouped_on) {
                var row_data = {};
                row_data[group.grouped_on] = group;
                var group_label = _t("Undefined");
                var group_column = _(self.columns).detect(function (column) {
                    return column.id === group.grouped_on; });
                if (group_column) {
                    try {
                        group_label = group_column.format(row_data, {
                            value_if_empty: _t("Undefined"),
                            process_modifiers: false
                        });
                    } catch (e) {
                        group_label = _.str.escapeHTML(row_data[group_column.id].value);
                    }
                } else {
                    group_label = group.value;
                    if (group_label instanceof Array) {
                        group_label = group_label[1];
                    }
                    if (group_label === false) {
                        group_label = _t('Undefined');
                    }
                    group_label = _.str.escapeHTML(group_label);
                }
                    
                // group_label is html-clean (through format or explicit
                // escaping if format failed), can inject straight into HTML
                $group_column.html(_.str.sprintf(_t("%s (%d)"),
                    group_label, group.length));

                if (group.length && group.openable) {
                    // Make openable if not terminal group & group_by_no_leaf
                    $group_column.prepend('<span class="ui-icon ui-icon-triangle-1-e" style="float: left;">');
                } else {
                    // Kinda-ugly hack: jquery-ui has no "empty" icon, so set
                    // wonky background position to ensure nothing is displayed
                    // there but the rest of the behavior is ui-icon's
                    $group_column.prepend('<span class="ui-icon" style="float: left; background-position: 150px 150px">');
                }
            }
            self.indent($group_column, group.level);

            if (self.options.selectable) {
                $row.append('<td>');
            }
            _(self.columns).chain()
                .filter(function (column) { return column.invisible !== '1'; })
                .each(function (column) {
                    if (column.meta) {
                        // do not do anything
                    } else if (column.id in group.aggregates) {
                        var r = {};
                        r[column.id] = {value: group.aggregates[column.id]};
                        $('<td class="oe_number">')
                            .html(column.format(r, {process_modifiers: false}))
                            .appendTo($row);
                    } else {
                        $row.append('<td>');
                    }
                });
            if (self.options.deletable) {
                $row.append('<td class="oe_list_group_pagination">');
            }
        });
        return placeholder;
    },
    bind_child_events: function (child) {
        var $this = $(this),
             self = this;
        $(child).bind('selected', function (e, _0, _1, deselected) {
            // can have selections spanning multiple links
            var selection = self.get_selection();
            $this.trigger(e, [selection.ids, selection.records, deselected]);
        }).bind(this.passthrough_events, function (e) {
            // additional positional parameters are provided to trigger as an
            // Array, following the event type or event object, but are
            // provided to the .bind event handler as *args.
            // Convert our *args back into an Array in order to trigger them
            // on the group itself, so it can ultimately be forwarded wherever
            // it's supposed to go.
            var args = Array.prototype.slice.call(arguments, 1);
            $this.trigger.call($this, e, args);
        });
    },
    render_dataset: function (dataset) {
        var self = this,
            list = new (this.view.options.ListType)(this, {
                options: this.options,
                columns: this.columns,
                dataset: dataset,
                records: this.records
            });
        this.bind_child_events(list);

        var view = this.view,
            limit = view._limit,
            page = this.datagroup.openable ? this.page : view.page;

        var fields = _.pluck(_.select(this.columns, function(x) {return x.tag == "field";}), 'name');
        var options = { offset: page * limit, limit: limit, context: {bin_size: true} };
        //TODO xmo: investigate why we need to put the setTimeout
        return $.async_when().then(function() {
            return dataset.read_slice(fields, options).then(function (records) {
                // FIXME: ignominious hacks, parents (aka form view) should not send two ListView#reload_content concurrently
                if (self.records.length) {
                    self.records.reset(null, {silent: true});
                }
                if (!self.datagroup.openable) {
                    view.configure_pager(dataset);
                } else {
                    if (dataset.size() == records.length) {
                        // only one page
                        self.$row.find('td.oe_list_group_pagination').find('button').remove();
                        self.$row.find('td.oe_list_group_pagination').find('span').remove();
                    } else {
                        self.max_page_index = Math.ceil(dataset.size() / limit) - 1;
                        self.$row
                            .find('.oe_list_pager_state')
                                .text(_.str.sprintf(_t("%(page)d/%(page_count)d"), {
                                    page: page + 1,
                                    page_count: self.max_page_index + 1
                                }))
                            .end()
                            .find('button[data-pager-action=previous]')
                                .toggleClass('disabled', page === 0)
                            .end()
                            .find('button[data-pager-action=next]')
                                .toggleClass('disabled', page === self.max_page_index);
                    }
                }

                self.records.add(records, {silent: true});
                list.render();
                if (_.isEmpty(records)) {
                    view.no_result();
                }
                return list;
            });
        });
    },
    setup_resequence_rows: function (list, dataset) {
        // drag and drop enabled if list is not sorted (unless it is sorted by
        // sequence (ASC)), and there is a visible column with @widget=handle
        // or "sequence" column in the view.
        if ((dataset.sort && dataset.sort() && dataset.sort() !== 'sequence'
            && dataset.sort() !== 'sequence ASC')
            || !_(this.columns).any(function (column) {
                    return column.widget === 'handle'
                        || column.name === 'sequence'; })) {
            return;
        }
        var sequence_field = _(this.columns).find(function (c) {
            return c.widget === 'handle';
        });
        var seqname = sequence_field ? sequence_field.name : 'sequence';

        // ondrop, move relevant record & fix sequences
        list.$current.sortable({
            axis: 'y',
            items: '> tr[data-id]',
            helper: 'clone'
        });
        if (sequence_field) {
            list.$current.sortable('option', 'handle', '.oe_list_field_handle');
        }
        list.$current.sortable('option', {
            start: function (e, ui) {
                ui.placeholder.height(ui.item.height());
            },
            stop: function (event, ui) {
                var to_move = list.records.get(ui.item.data('id')),
                    target_id = ui.item.prev().data('id'),
                    from_index = list.records.indexOf(to_move),
                    target = list.records.get(target_id);
                if (list.records.at(from_index - 1) == target) {
                    return;
                }

                list.records.remove(to_move, {silent: true});
                var to = target_id ? list.records.indexOf(target) + 1 : 0;
                list.records.add(to_move, { at: to, silent: true });

                // resequencing time!
                var record, index = to,
                    // if drag to 1st row (to = 0), start sequencing from 0
                    // (exclusive lower bound)
                    seq = to ? list.records.at(to - 1).get(seqname) : 0;
                var defs = [];
                var fct = function (dataset, id, seq) {
                    defs.push($.async_when().then(function () {
                        var attrs = {};
                        attrs[seqname] = seq;
                        return dataset.write(id, attrs, {internal_dataset_changed: true});
                    }));
                };
                while (++seq, (record = list.records.at(index++))) {
                    // write are independent from one another, so we can just
                    // launch them all at the same time and we don't really
                    // give a fig about when they're done
                    fct(dataset, record.get('id'), seq);
                    record.set(seqname, seq);
                }
                $.when.apply($, defs).then(function () {
                    // use internal_dataset_changed and trigger one onchange after all writes
                    dataset.trigger("dataset_changed");
                });
            }
        });
    },
    render: function (post_render) {
        var self = this;
        var $el = $('<tbody>');
        this.elements = [$el[0]];

        this.datagroup.list(
            _(this.view.visible_columns).chain()
                .filter(function (column) { return column.tag === 'field';})
                .pluck('name').value(),
            function (groups) {
                $el[0].appendChild(
                    self.render_groups(groups));
                if (post_render) { post_render(); }
            }, function (dataset) {
                self.render_dataset(dataset).then(function (list) {
                    self.children[null] = list;
                    self.elements =
                        [list.$current.replaceAll($el)[0]];
                    self.setup_resequence_rows(list, dataset);
                }).always(function() {
                    if (post_render) { post_render(); }
                    self.view.trigger('view_list_rendered');
                });
            });
        return $el;
    },
    /**
     * Returns the ids of all selected records for this group, and the records
     * themselves
     */
    get_selection: function () {
        var ids = [], records = [];

        _(this.children)
            .each(function (child) {
                var selection = child.get_selection();
                ids.push.apply(ids, selection.ids);
                records.push.apply(records, selection.records);
            });

        return {ids: ids, records: records};
    },
    on_records_reset: function () {
        this.children = {};
        $(this.elements).remove();
    },
    get_records: function () {
        if (_(this.children).isEmpty()) {
            if (!this.datagroup.length) {
                return;
            }
            return {
                count: this.datagroup.length,
                values: this.datagroup.aggregates
            };
        }
        return _(this.children).chain()
            .map(function (child) {
                return child.get_records();
            }).flatten().value();
    }
});

/**
 * Serializes concurrent calls to this asynchronous method. The method must
 * return a deferred or promise.
 *
 * Current-implementation is class-serialized (the mutex is common to all
 * instances of the list view). Can be switched to instance-serialized if
 * having concurrent list views becomes possible and common.
 */
function synchronized(fn) {
    var fn_mutex = new utils.Mutex();
    return function () {
        var obj = this;
        var args = _.toArray(arguments);
        return fn_mutex.exec(function () {
            if (obj.isDestroyed()) { return $.when(); }
            return fn.apply(obj, args);
        });
    };
}

var DataGroup =  Class.extend({
   init: function(parent, model, domain, context, group_by, level) {
       this.model = new Model(model, context, domain);
       this.group_by = group_by;
       this.context = context;
       this.domain = domain;

       this.level = level || 0;
   },
   list: function (fields, ifGroups, ifRecords) {
       var self = this;
       if (!_.isEmpty(this.group_by)) {
           // ensure group_by fields are read.
           fields = _.unique((fields || []).concat(this.group_by));
       }
       var query = this.model.query(fields).order_by(this.sort).group_by(this.group_by);
       $.when(query).done(function (querygroups) {
           // leaf node
           if (!querygroups) {
               var ds = new data.DataSetSearch(self, self.model.name, self.model.context(), self.model.domain());
               ds._sort = self.sort;
               ifRecords(ds);
               return;
           }
           // internal node
           var child_datagroups = _(querygroups).map(function (group) {
               var child_context = _.extend(
                   {}, self.model.context(), group.model.context());
               var child_dg = new DataGroup(
                   self, self.model.name, group.model.domain(),
                   child_context, group.model._context.group_by,
                   self.level + 1);
               child_dg.sort = self.sort;
               // copy querygroup properties
               child_dg.__context = child_context;
               child_dg.__domain = group.model.domain();
               child_dg.folded = group.get('folded');
               child_dg.grouped_on = group.get('grouped_on');
               child_dg.length = group.get('length');
               child_dg.value = group.get('value');
               child_dg.openable = group.get('has_children');
               child_dg.aggregates = group.get('aggregates');
               return child_dg;
           });
           ifGroups(child_datagroups);
       });
   }
});

var StaticDataGroup = DataGroup.extend({
   init: function (dataset) {
       this.dataset = dataset;
   },
   list: function (fields, ifGroups, ifRecords) {
       ifRecords(this.dataset);
   }
});

var Column = Class.extend({
    init: function (id, tag, attrs) {
        _.extend(attrs, {
            id: id,
            tag: tag
        });
        this.modifiers = attrs.modifiers ? JSON.parse(attrs.modifiers) : {};
        delete attrs.modifiers;
        _.extend(this, attrs);

        if (this.modifiers['tree_invisible']) {
            this.invisible = '1';
        } else { delete this.invisible; }
    },
    modifiers_for: function (fields) {
        var out = {};
        var domain_computer = data.compute_domain;

        for (var attr in this.modifiers) {
            if (!this.modifiers.hasOwnProperty(attr)) { continue; }
            var modifier = this.modifiers[attr];
            out[attr] = _.isBoolean(modifier)
                ? modifier
                : domain_computer(modifier, fields);
        }

        return out;
    },
    to_aggregate: function () {
        if (this.type !== 'integer' && this.type !== 'float' && this.type !== 'monetary') {
            return {};
        }

        var aggregation_func = (this.sum && 'sum') || (this.avg && 'avg') ||
                               (this.max && 'max') || (this.min && 'min');

        if (!aggregation_func) {
            return {};
        }

        var C = function (fn, label) {
            this['function'] = fn;
            this.label = label;
        };
        C.prototype = this;
        return new C(aggregation_func, this[aggregation_func]);
    },
    /**
     *
     * @param row_data record whose values should be displayed in the cell
     * @param {Object} [options]
     * @param {String} [options.value_if_empty=''] what to display if the field's value is ``false``
     * @param {Boolean} [options.process_modifiers=true] should the modifiers be computed ?
     * @param {String} [options.model] current record's model
     * @param {Number} [options.id] current record's id
     * @return {String}
     */
    format: function (row_data, options) {
        options = options || {};
        var attrs = {};
        if (options.process_modifiers !== false) {
            attrs = this.modifiers_for(row_data);
        }
        if (attrs.invisible) { return ''; }

        if (!row_data[this.id]) {
            return options.value_if_empty === undefined
                    ? ''
                    : options.value_if_empty;
        }
        return this._format(row_data, options);
    },
    /**
     * Method to override in order to provide alternative HTML content for the
     * cell. Column._format will simply call ``instance.web.format_value`` and
     * escape the output.
     *
     * The output of ``_format`` will *not* be escaped by ``format``, any
     * escaping *must be done* by ``format``.
     *
     * @private
     */
    _format: function (row_data, options) {
        return _.escape(formats.format_value(
            row_data[this.id].value, this, options.value_if_empty));
    }
});
ListView.Column = Column;

var MetaColumn = Column.extend({
    meta: true,
    init: function (id, string) {
        this._super(id, '', {string: string});
    }
});
// to do: do this in a better way (communicate with view_list_editable)
ListView.MetaColumn = MetaColumn;  

var ColumnButton = Column.extend({
    /**
     * Return an actual ``<button>`` tag
     */
    format: function (row_data, options) {
        options = options || {};
        var attrs = {};
        if (options.process_modifiers !== false) {
            attrs = this.modifiers_for(row_data);
        }
        if (attrs.invisible) { return ''; }
        var template = this.icon && 'ListView.row.button' || 'ListView.row.text_button';
        return QWeb.render(template, {
            widget: this,
            prefix: session.prefix,
            disabled: attrs.readonly
                || isNaN(row_data.id.value)
                || data.BufferedDataSet.virtual_id_regex.test(row_data.id.value)
        });
    }
});

var ColumnBoolean = Column.extend({
    /**
     * Return a potentially disabled checkbox input
     *
     * @private
     */
    _format: function (row_data, options) {
        return _.str.sprintf('<input type="checkbox" %s readonly="readonly"/>',
                 row_data[this.id].value ? 'checked="checked"' : '');
    }
});

var ColumnBinary = Column.extend({
    /**
     * Return a link to the binary data as a file
     *
     * @private
     */
    _format: function (row_data, options) {
        var text = _t("Download"), filename=_t('Binary file');
        var value = row_data[this.id].value;
        if (!value) {
            return options.value_if_empty || '';
        }

        var download_url;
        if (value.substr(0, 10).indexOf(' ') == -1) {
            download_url = "data:application/octet-stream;base64," + value;
        } else {
            download_url = session.url('/web/content', {model: options.model, field: this.id, id: options.id, download: true});
            if (this.filename) {
                download_url += '&filename_field=' + this.filename;
            }
        }
        if (this.filename && row_data[this.filename]) {
            text = _.str.sprintf(_t("Download \"%s\""), formats.format_value(
                    row_data[this.filename].value, {type: 'char'}));
            filename = row_data[this.filename].value;
        }
        return _.template('<a download="<%-download%>" href="<%-href%>"><%-text%></a> (<%-size%>)')({
            text: text,
            href: download_url,
            size: utils.binary_to_binsize(value),
            download: filename,
        });
    }
});

var ColumnChar = Column.extend({
    replacement: '*',
    /**
     * If password field, only display replacement characters (if value is
     * non-empty)
     */
    _format: function (row_data, options) {
        var value = row_data[this.id].value;
        if (value && this.password === 'True') {
            return value.replace(/[\s\S]/g, _.escape(this.replacement));
        }
        return this._super(row_data, options);
    }
});

var ColumnProgressBar = Column.extend({
    /**
     * Return a formatted progress bar display
     *
     * @private
     */
    _format: function (row_data, options) {
        return _.template(
            '<progress value="<%-value%>" max="100"><%-value%>%</progress>')({
                value: _.str.sprintf("%.0f", row_data[this.id].value || 0)
            });
    }
});

var ColumnHandle = Column.extend({
    init: function () {
        this._super.apply(this, arguments);
        // Handle overrides the field to not be form-editable.
        this.modifiers.readonly = true;
    },
    /**
     * Return styling hooks for a drag handle
     *
     * @private
     */
    _format: function (row_data, options) {
        return '<i class="oe_list_handle fa fa-circle"/>';
    }
});

var ColumnMany2OneButton = Column.extend({
    _format: function (row_data, options) {
        this.has_value = !!row_data[this.id].value;
        this.icon = this.has_value ? 'gtk-yes' : 'gtk-no';
        this.string = this.has_value ? _t('View') : _t('Create');
        return QWeb.render('Many2OneButton.cell', {
            'widget': this,
            'prefix': session.prefix,
        });
    },
});

var ColumnMany2Many = Column.extend({
    _format: function (row_data, options) {
        if (!_.isEmpty(row_data[this.id].value)) {
            // If value, use __display version for printing
            row_data[this.id] = row_data[this.id + '__display'];
        }
        return this._super(row_data, options);
    }
});

var ColumnReference = Column.extend({
    _format: function (row_data, options) {
        if (!_.isEmpty(row_data[this.id].value)) {
            // If value, use __display version for printing
            if (!!row_data[this.id + '__display']) {
                row_data[this.id] = row_data[this.id + '__display'];
            } else {
                row_data[this.id] = {'value': ''};
            }
        }
        return this._super(row_data, options);
    }
});

var ColumnUrl = Column.extend({
    /**
     * Regex checking if a URL has a scheme
     */
    PROTOCOL_REGEX: /^(?!\w+:?\/\/)/,

    /**
     * Format a column as a URL if the column has content.
     * Add "//" (inherit current protocol) specified in
     * RFC 1808, 2396, and 3986 if no other protocol is included.
     *
     * @param row_data record whose values should be displayed in the cell
     * @param options
     */
    _format: function(row_data, options) {
        var value = row_data[this.id].value;

        if (value) {
            return _.template("<a href='<%-href%>' target='_blank'><%-text%></a>")({
                href: value.trim().replace(this.PROTOCOL_REGEX, '//'),
                text: value
            });
        }
        return this._super(row_data, options);
    }
});

var ColumnMonetary = Column.extend({

    _format: function (row_data, options) {
        //name of currency field is defined either by field attribute, in view options or we assume it is named currency_id
        var currency_field = (this.options && this.options.currency_field) || this.currency_field || 'currency_id';
        var currency_id = row_data[currency_field] && row_data[currency_field].value[0];
        var currency = session.get_currency(currency_id);
        var digits_precision = this.digits || (currency && currency.digits);
        var value = formats.format_value(row_data[this.id].value || 0, {type: this.type, digits: digits_precision}, options.value_if_empty);
        if (currency) {
            if (currency.position === "after") {
                value += '&nbsp;' + currency.symbol;
            } else {
                value = currency.symbol + '&nbsp;' + value;
            }
        }
        return value;
    },
});

var ColumnToggleButton = Column.extend({
    format: function (row_data, options) {
        this._super(row_data, options);
        var button_tips = JSON.parse(this.options);
        var fieldname = this.field_name;
        var has_value = row_data[fieldname] && !!row_data[fieldname].value;
        this.icon = has_value ? 'gtk-yes' : 'gtk-normal';
        this.string = has_value ? _t(button_tips ? button_tips['active']: ''): _t(button_tips ? button_tips['inactive']: '');
        return QWeb.render('toggle_button', {
            widget: this,
            prefix: session.prefix,
        });
    },
});

/**
 * Registry for column objects used to format table cells (and some other tasks
 * e.g. aggregation computations).
 *
 * Maps a field or button to a Column type via its ``$tag.$widget``,
 * ``$tag.$type`` or its ``$tag`` (alone).
 *
 * This specific registry has a dedicated utility method ``for_`` taking a
 * field (from fields_get/fields_view_get.field) and a node (from a view) and
 * returning the right object *already instantiated from the data provided*.
 *
 * @type {instance.web.Registry}
 */
list_widget_registry
    .add('field', Column)
    .add('field.boolean', ColumnBoolean)
    .add('field.binary', ColumnBinary)
    .add('field.char', ColumnChar)
    .add('field.progressbar', ColumnProgressBar)
    .add('field.handle', ColumnHandle)
    .add('button', ColumnButton)
    .add('field.many2onebutton', ColumnMany2OneButton)
    .add('field.reference', ColumnReference)
    .add('field.many2many', ColumnMany2Many)
    .add('field.url', ColumnUrl)
    .add('button.toggle_button', ColumnToggleButton)
    .add('field.monetary', ColumnMonetary);

function for_ (id, field, node) {
    var description = _.extend({tag: node.tag}, field, node.attrs);
    var tag = description.tag;
    var Type = list_widget_registry.get_any([
        tag + '.' + description.widget,
        tag + '.'+ description.type,
        tag
    ]);
    return new Type(id, node.tag, description);
}

return ListView;
});


