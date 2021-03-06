Ext.define('CustomApp', {
    extend: 'Rally.app.App',
    componentCls: 'app',
    defaults: { padding: 10, margin: 5 },

    // Title/version
    title: 'Lean Project Charter/Releae Predictability',
    version: '0.30',

    // Global variables
    _debug: true,
    _release_combo_box: null,
    _target_backlog_number_box: null,
    _release: null,
    _project: null,
    _child_project_count: null,
    _iterations: [],
    _iteration_hash: {},
    _aligned_iteration_oids: [],
    _releases: [],
    _aligned_release_oids: [],
    _current_iteration: null,
    _current_iteration_index: null,
    _release_flow_hash: {},
    _asynch_return_flags: {},
    _velocities: {},
    _trend_data: {},
    _target_backlog: 0,
    _really_big_number: 1000000000000000,
    _chart_data: null,

    // Layout items
    items: [
        {
            xtype: 'container',
            itemId: 'selector_box',
            layout: { type: 'hbox' },
            defaults: { margin: 5 }
        },
        {
            xtype: 'container',
            itemId: 'chart_box'
        }
    ],

    launch: function() {
        this._addReleaseSelector();
        this._addTargetBacklogBox();
    },

    // Clears the asynch return flags and kicks off the data collection/charting process chain
    _kickOff: function() {
        this._asynch_return_flags = {};
        this._release = this._release_combo_box.getRecord();
        console.log('_kickOff: this._release: ', this._release);
        this._findChildProjects();
    },

    _addReleaseSelector: function() {
        this._iterations = [];
        this._release_combo_box = Ext.create('Rally.ui.combobox.ReleaseComboBox', {
            xtype:'rallyreleasecombobox',
            listeners: {
                scope: this,
                change: function(rb, new_value, old_value) {
                    this._kickOff();
                },
                ready: function(rb) {
                    this._kickOff();
                }
            }
        });
        this.down('#selector_box').add(this._release_combo_box);
    },

    _addTargetBacklogBox: function() {
        var me = this;

        me._target_backlog_number_box = Ext.create('Rally.ui.NumberField', {
            xtype: 'rallynumberfield',
            fieldLabel: 'Target Backlog (Story Points)',
            value: 0.0
        });

        this.down('#selector_box').add(me._target_backlog_number_box);
        this.down('#selector_box').add({
            xtype: 'rallybutton',
            text: 'Refresh',
            handler: function() {
                // Update target backlog from dialog
                me._target_backlog = me._target_backlog_number_box.getValue();
                me._kickOff();
            }
        });
    },

    _findChildProjects: function() {

        var me = this;

        var project = this.getContext().getProject();
        var project_oid = project.ObjectID;
        var project_model = Rally.data.ModelFactory.getModel({
            type: 'Project',
            success: function(model) {
                model.load(project_oid, {
                    fetch: ['Name', 'Children'],
                    callback: function(result, operation) {
                        if(operation.wasSuccessful()) {
                            me._project = result;
                            me._child_project_count = result.get('Children').Count;
                        }
                        me._findIterationsBetweenDates();
                    }
                });
            }
        });
    },

    // Gets list of all Releases that match timebox of selected release
    // Calls _findTodaysReleaseBacklog when done
    _findAlignedReleases: function() {

        var me = this;

        var this_release = this._release_combo_box.getRecord();
        var this_release_name = this_release.get('Name');
        var this_release_oid = this_release.get('ObjectID');
        me._aligned_release_oids.push(this_release_oid);

        var release_query = [
            { property: "Name", operator:"=", value: this_release_name },
        ];

        var release_store = Ext.create('Rally.data.WsapiDataStore', {
            model: 'Release',
            autoLoad: true,
            filters: release_query,
            sorters: [
                {
                    property: 'ReleaseDate',
                    direction: 'ASC'
                }
            ],
            fetch: [ 'ObjectID', 'Name', 'PlannedVelocity', 'ReleaseStartDate', 'ReleaseDate'],
            context: { projectScopeDown: true },
            listeners: {
                scope: this,
                load: function(store, records) {
                    Ext.Array.each(records, function(release) {
                        var release_oid = release.get('ObjectID');
                        // Make sure it's a child release and isn't already in the list
                        if (me._aligned_release_oids.indexOf(release_oid) === -1) {
                            if (me._checkReleaseAlignment(release)) {
                                me._aligned_release_oids.push(release_oid);
                            }
                        }
                    });
                    console.log('_findAlignedReleases: me._aligned_release_oids: ', me._aligned_release_oids);
                    me._asynch_return_flags["aligned_releases"] = true;
                    me._findTodaysReleaseBacklog();
                    me._findReleaseBacklogAtEachIteration();
                    me._makeChart();
                }
            }
        });
    },

    // Check to see if two Release Timeboxes align
    _checkReleaseTimebox: function(parent_release, release) {

        var parent_start_date = parent_release.get('ReleaseStartDate');
        var parent_release_date = parent_release.get('ReleaseDate');
        var start_date = release.get('ReleaseStartDate');
        var release_date = release.get('ReleaseDate');

        return (start_date.getTime() === parent_start_date.getTime() &&
                release_date.getTime() === parent_release_date.getTime());
    },

    // Check to see if Release Timebox aligns with that of Top-level Release
    _checkReleaseAlignment: function(release) {
        var parent_release = this._release;
        if (parent_release) {
            return this._checkReleaseTimebox(parent_release, release);
        } else {
            return false;
        }
    },

    _findCurrentIteration: function() {
        var me = this;
        var today_date = new Date();

        var today_iso_string = Rally.util.DateTime.toIsoString(today_date, true).replace(/T.*$/,"");
        this._log('Find iterations where StartDate <= ' + today_iso_string + ' and EndDate >= ' + today_iso_string );

        var iteration_query = [
            { property: "StartDate", operator:"<=", value: today_iso_string },
            { property: "EndDate", operator:">=", value: today_iso_string }
        ];

        var current_iteration_store = Ext.create('Rally.data.WsapiDataStore',{
            model: 'Iteration',
            autoLoad: true,
            filters: iteration_query,
            fetch: ['Name', 'PlannedVelocity', 'StartDate', 'EndDate'],
            context: { projectScopeDown: false },
            listeners: {
                scope: this,
                load: function(store, records) {
                    // This will be not be correct if we have overlapping iterations for some reason
                    var current_iteration = records[0];

                    var this_release = this._release;
                    var this_release_date = this_release.get('ReleaseDate');
                    var current_iteration_end_date;
                    if (current_iteration) {
                        current_iteration_end_date = current_iteration.get('EndDate');

                        // If we're past the ReleaseDate, then pick the last iteration in the
                        // selected Release to be the "current" iteration.
                        if (current_iteration_end_date > this_release_date) {
                            current_iteration = me._iterations[me._iterations.length-1];
                        }
                    } else {
                        // Current iteration not found. This can happen if we're between iterations
                        // within our current release (like on a weekend). Find the closest
                        // iteration to "now".
                        var today = new Date().getTime();
                        // Times are in milliseconds - use our really big number to make
                        // sure we get a difference less than our "infinity"
                        var min_time_delta = this._really_big_number;
                        var closest_iteration;
                        Ext.Array.each(me._iterations, function(iteration) {
                            var this_iteration_end_date = iteration.get('EndDate');
                            var time_delta = Math.abs(this_iteration_end_date.getTime() - today);
                            if (time_delta < min_time_delta) {
                                closest_iteration = iteration;
                                min_time_delta = time_delta;
                            }
                        });
                        current_iteration = closest_iteration;
                        current_iteration_end_date = current_iteration.get('EndDate');
                    }

                    me._current_iteration = current_iteration;

                    // Calculate array index of current_iteration
                    var index = 0;
                    var index_of_current = 0;
                    Ext.Array.each(me._iterations, function(iteration) {
                        var this_iteration_end_date = iteration.get('EndDate');
                        if (this_iteration_end_date === current_iteration_end_date) {
                            index_of_current = index;
                        }
                        index++;
                    });
                    me._current_iteration_index = index_of_current;
                    /* --
                    console.log('me._current_iteration: ', me._current_iteration);
                    console.log('me.current_iteration_index: ', me._current_iteration_index);
                    -- */

                    me._asynch_return_flags["current_iteration"] = true;
                    if (me._child_project_count > 0) {
                        me._findAlignedReleases();
                    } else {
                        me._asynch_return_flags["aligned_releases"] = true;
                        me._findTodaysReleaseBacklog();
                        me._findReleaseBacklogAtEachIteration();
                    }
                    me._makeChart();
                }
            }
        });

    },

    // Check to see if two Iteration Timeboxes align
    _checkIterationTimebox: function(parent_iteration, iteration) {
        var parent_start_date = parent_iteration.get('StartDate');
        var parent_end_date = parent_iteration.get('EndDate');
        var start_date = iteration.get('StartDate');
        var end_date = iteration.get('EndDate');

        return (start_date.getTime() === parent_start_date.getTime() &&
                end_date.getTime() === parent_end_date.getTime());
    },

    // Check to see if Iteration Timebox aligns with that of Parent Iteration
    _checkIterationAlignment: function(iteration) {
        var iteration_name = iteration.get('Name');
        var parent_iteration = this._iteration_hash[iteration_name];
        if (parent_iteration) {
            return this._checkIterationTimebox(parent_iteration, iteration);
        } else {
            return false;
        }
    },

    // If we're aggregating data from child projects, make sure that their
    // Iteration timeboxes line up with Iterations in top-scoped Project
    _findAlignedIterations: function() {

        var me = this;

        // Run the same query as _findIterationsBetweenDates(), but with projectScopeDown = true

        // dates are given in JS, but we need them to be ISO
        // Rally.util.DateTime.toIsoString(date, true); will return a date in UTC
        var start_date_iso = Rally.util.DateTime.toIsoString(this._release.get('ReleaseStartDate'), true);
        var end_date_iso = Rally.util.DateTime.toIsoString(this._release.get('ReleaseDate'), true);
        this._log('Find iterations between ' + start_date_iso + ' and ' + end_date_iso );

        var iteration_query = [
            { property: "StartDate", operator:">=", value: start_date_iso },
            // Changed to StartDate for high end of query since Philips expects to
            // see any Iteration that "touches" a Release be included
            { property: "StartDate", operator:"<=", value: end_date_iso }
        ];

        // Start out by grabbing Iterations at current project-level only
        // If we have child projects, then we'll get child iterations later
        var iteration_store = Ext.create('Rally.data.WsapiDataStore', {
            model: 'Iteration',
            autoLoad: true,
            filters: iteration_query,
            sorters: [
                {
                    property: 'EndDate',
                    direction: 'ASC'
                }
            ],
            fetch: [ 'ObjectID', 'Name', 'PlannedVelocity', 'StartDate', 'EndDate'],
            context: { projectScopeDown: true },
            listeners: {
                scope: this,
                load: function(store, records) {
                    Ext.Array.each(records, function(iteration) {
                        var iteration_oid = iteration.get('ObjectID');
                        // Make sure it's a child iteration and isn't already in the list
                        if (me._aligned_iteration_oids.indexOf(iteration_oid) === -1) {
                            if (me._checkIterationAlignment(iteration)) {
                                me._aligned_iteration_oids.push(iteration_oid);
                            }
                        }
                    });
                    me._asynch_return_flags["aligned_iterations"] = true;
                    console.log("me._asynch_return_flags['aligned_iterations']: ", me._asynch_return_flags["aligned_iterations"]);
                    me._findAcceptedItemsInEachIteration();
                    me._findCurrentIteration();
                    me._makeChart();
                }
            }
        });

    },

    // Checks to see if an iteration is aligned with a Parent Project Iteration
    _isAligned: function(iteration) {

        var me = this;

        var iteration_ref = Ext.create('Rally.util.Ref', iteration._ref);
        var iteration_oid = iteration_ref.getOid();
        var is_aligned = false;
        if (me._aligned_iteration_oids.indexOf(iteration_oid) !== -1) {
            is_aligned = true;
        } else {
            is_aligned = false;
        }
        return is_aligned;
    },

    _findIterationsBetweenDates: function() {

        var me = this;

        if ( this._chart ) {
            this._chart.destroy();
        }

        // Initialize release flow hash
        this._release_flow_hash = {}; // key is date (NOT date/time)

        // dates are given in JS, but we need them to be ISO
        // Rally.util.DateTime.toIsoString(date, true); will return a date in UTC
        var start_date_iso = Rally.util.DateTime.toIsoString(this._release.get('ReleaseStartDate'), true);
        var end_date_iso = Rally.util.DateTime.toIsoString(this._release.get('ReleaseDate'), true);
        this._log('Find iterations between ' + start_date_iso + ' and ' + end_date_iso );

        var iteration_query = [
            { property: "StartDate", operator:">=", value: start_date_iso },
            // Changed to StartDate for high end of query since Philips expects to
            // see any Iteration that "touches" a Release be included
            { property: "StartDate", operator:"<=", value: end_date_iso }
        ];

        // Start out by grabbing Iterations at current project-level only
        // If we have child projects, then we'll get child iterations later
        var iteration_store = Ext.create('Rally.data.WsapiDataStore', {
            model: 'Iteration',
            autoLoad: true,
            filters: iteration_query,
            sorters: [
                {
                    property: 'EndDate',
                    direction: 'ASC'
                }
            ],
            fetch: ['ObjectID', 'Name', 'PlannedVelocity', 'StartDate', 'EndDate'],
            context: { projectScopeDown: false },
            listeners: {
                scope: this,
                load: function(store, records) {
                    me._iterations = records;
                    Ext.Array.each(records, function(iteration) {
                        var iteration_name = iteration.get('Name');
                        var iteration_oid = iteration.get('ObjectID');
                        me._iteration_hash[iteration_name] = iteration;
                        me._aligned_iteration_oids.push(iteration_oid);
                    });
                    me._log(['me._iterations: ', me._iterations]);

                    if (me._iterations.length > 0) {
                        if (me._child_project_count > 0) {
                            me._findAlignedIterations();
                        } else {
                            me._asynch_return_flags["aligned_iterations"] = true;
                            me._findReleaseBacklogAtEachIteration();
                            me._findAcceptedItemsInEachIteration();
                            me._findCurrentIteration();
                            me._makeChart();
                        }
                    } else {
                        me._noIterationsNotify();
                    }

                    me._asynch_return_flags["iterations"] = true;
                }
            }
        });
    },

    _findAcceptedItemsInEachIteration: function() {
        var me = this;

        me._log(["_findAcceptedItemsInEachIteration: me._iterations: ", me._iterations]);

        var iteration_query = [
            { property: "ScheduleState", operator: ">=", value: "Accepted" },
            { property: "Release.Name", operator: "=", value: this._release.get("Name") }
        ];

        this._velocities = {}; // key will be iteration name

        Ext.create('Rally.data.WsapiDataStore', {
            model:'UserStory',
            autoLoad: true,
            filters: iteration_query,
            fetch:['Name', 'PlanEstimate', 'Iteration'],
            context: { projectScopeDown: true },
            listeners:{
                scope: this,
                load: function(store, records) {
                    Ext.Array.each(records, function(record) {
                        if ( record.get('Iteration') ) {
                            var iteration = record.get('Iteration');

                            // Check if Object's Iteration aligns with a Parent Project Iteration
                            if (me._isAligned(iteration)) {
                                var iteration_name = record.get('Iteration').Name;
                                if ( record.get('PlanEstimate') ) {
                                    if (typeof(me._velocities[iteration_name]) == 'undefined') {
                                        me._log("clearing velocity for " + iteration_name);
                                        me._velocities[iteration_name] = 0;
                                    }
                                    me._velocities[iteration_name] += parseInt(record.get('PlanEstimate'), 10);
                                }
                            }
                        }
                    });
                    this._asynch_return_flags["story_velocity"] = true;
                    this._makeChart();
                }
            }
        });

        Ext.create('Rally.data.WsapiDataStore',{
            model:'Defect',
            autoLoad: true,
            filters: iteration_query,
            fetch:['Name', 'PlanEstimate', 'Iteration'],
            context: { projectScopeDown: true },
            listeners:{
                scope: this,
                load: function(store, records) {
                    Ext.Array.each(records, function(record){
                        if ( record.get('Iteration') ) {
                            var iteration = record.get('Iteration');
                            // Check if Object's Iteration aligns with a Parent Project Iteration
                            if (me._isAligned(iteration)) {
                                var iteration_name = record.get('Iteration').Name;
                                if ( record.get('PlanEstimate') ) {
                                    if (typeof(me._velocities[iteration_name]) == 'undefined') {
                                        me._log("clearing velocity for " + iteration_name);
                                        me._velocities[iteration_name] = 0;
                                    }
                                    me._velocities[iteration_name] += parseInt(record.get('PlanEstimate'), 10);
                                }
                            }
                        }
                    });
                    this._asynch_return_flags["defect_velocity"] = true;
                    this._makeChart();
                }
            }
        });
    },

    // This function finds items that were added to the backlog today and are not yet
    // captured in ReleaseCumulativeFlow data
    _findTodaysReleaseBacklog: function() {

        var me = this;
        var this_release = this._release.get('ObjectID');
        var this_iteration = this._current_iteration;

        if (!this_iteration) {
            this._asynch_return_flags["story_backlog_today"] = true;
            this._asynch_return_flags["defect_backlog_today"] = true;
        } else {
            var this_iteration_end_date = this_iteration.get('EndDate');
            var this_iteration_end_iso_string = Rally.util.DateTime.toIsoString(this_iteration_end_date, true).replace(/T.*$/,"");

            // Initialize today's cumulative flow data with yesterday's
            me._release_flow_hash[this_iteration_end_iso_string] = 0;

            var release_filters = Ext.create('Rally.data.QueryFilter', {
                property: 'Release.ObjectID',
                operator: '=',
                value: this_release
            });

            // Add child releases into query scoping
            if (me._child_project_count > 0) {
                Ext.Array.each(me._aligned_release_oids, function(release_oid) {
                    if (release_oid !== this_release) {
                        var this_filter = Ext.create('Rally.data.QueryFilter', {
                            property: 'Release.ObjectID',
                            operator: '=',
                            value: release_oid
                        });

                        if (!release_filters) {
                            release_filters = this_filter;
                        } else {
                            release_filters = release_filters.or(this_filter);
                        }
                    }
                });
            }

            // Do a non-flow query for Work Products assigned to the Release
            // include them on the backlog line
            Ext.create('Rally.data.WsapiDataStore', {
                model:'UserStory',
                autoLoad: true,
                filters: release_filters,
                fetch:['Name', 'PlanEstimate', 'Release', 'Iteration', 'CreationDate'],
                context: { projectScopeDown: true },
                listeners:{
                    scope: this,
                    load: function(store, records) {
                        Ext.Array.each(records, function(record) {
                            var release = record.get('Release');
                            var iteration = record.get('Iteration');
                            // and we're not scheduled into an iteration
                            if ( record.get('PlanEstimate') && !iteration) {
                                // Check if Object's Release aligns with a Parent Project Release
                                if (me._isAligned(release)) {
                                    me._release_flow_hash[this_iteration_end_iso_string] += parseInt(record.get('PlanEstimate'), 10);
                                }
                            }
                        });
                        this._asynch_return_flags["story_backlog_today"] = true;
                        this._makeChart();
                    }
                }
            });

            Ext.create('Rally.data.WsapiDataStore',{
                model:'Defect',
                autoLoad: true,
                filters: release_filters,
                fetch:['Name', 'PlanEstimate', 'Release', 'Iteration', 'CreationDate'],
                context: { projectScopeDown: true },
                listeners:{
                    scope: this,
                    load: function(store, records) {
                        Ext.Array.each(records, function(record) {
                            var release = record.get('Release');
                            var iteration = record.get('Iteration');
                            if ( record.get('PlanEstimate') && !iteration ) {
                                // Check if Object's Release aligns with a Parent Project Release
                                if (me._isAligned(release)) {
                                    me._release_flow_hash[this_iteration_end_iso_string] += parseInt(record.get('PlanEstimate'), 10);
                                }
                            }
                        });
                        this._asynch_return_flags["defect_backlog_today"] = true;
                        this._makeChart();
                    }
                }
            });
        }
    },

    // Adjusts for Rally "zero'ing" the card creation time for cumulative flow cards
    // Example:
    // Actual card creation time: 2013-08-11T23:59:59
    // WSAPI-Reported card creation time: 2013-08-11T00:00:00
    // Adjusted card creation time: 2013-08-11T23:59:59
    _adjustCardTime: function(card_date) {
        var adjusted_date = Rally.util.DateTime.add(card_date, "hour", 23);
        adjusted_date = Rally.util.DateTime.add(adjusted_date, "minute", 59);
        adjusted_date = Rally.util.DateTime.add(adjusted_date, "second", 59);
        return adjusted_date;
    },

    _findReleaseBacklogAtEachIteration: function() {
        var me = this;
        me._release_flow = []; // in order of sprint end

        var this_release = me._release;
        var this_release_oid = this_release.get('ObjectID');

        var release_filters = Ext.create('Rally.data.QueryFilter', {
                property: 'ReleaseObjectID',
                operator: "=",
                value: this_release_oid
        });

        // Add child releases into query scoping
        if (me._child_project_count > 0) {
            Ext.Array.each(me._aligned_release_oids, function(release_oid) {
                if (release_oid !== this_release_oid) {
                    var this_filter = Ext.create('Rally.data.QueryFilter', {
                        property: 'ReleaseObjectID',
                        operator: '=',
                        value: release_oid
                    });

                    if (!release_filters) {
                        release_filters = this_filter;
                    } else {
                        release_filters = release_filters.or(this_filter);
                    }
                }
            });
        }

        Ext.create('Rally.data.WsapiDataStore',{
            model: 'ReleaseCumulativeFlowData',
            autoLoad: true,
            filters: release_filters,
            limit: 5000,
            listeners: {
                scope: this,
                load: function(store, cards) {
                    // each record is a sum of items in a particular state for the release on a given date
                    // could be 4-6 records for each day (one for each schedule state)
                    Ext.Array.each(cards, function(card) {
                        var card_creation_date = card.get('CreationDate');
                        var adjusted_card_creation_date = me._adjustCardTime(card_creation_date);
                        var capture_date = Rally.util.DateTime.toIsoString(
                            adjusted_card_creation_date, true
                        ).replace(/T.*$/,"");

                        var plan_estimate = card.get('CardEstimateTotal');
                        // me._doubleLineLog("plan_estimate", plan_estimate)

                        if ( !me._release_flow_hash[capture_date] ) {
                            me._release_flow_hash[capture_date] = 0;
                        }

                        me._release_flow_hash[capture_date] += plan_estimate;
                    });
                    // me._doubleLineLog("this._release_flow_hash::", me._release_flow_hash);
                    this._asynch_return_flags["flows"] = true;
                    me._makeChart();
                }
            }
        });
    },

    _assembleSprintData: function(){
        var me = this;
        var data = {
            Name: [],
            IterationEndDate: [],
            TotalBacklog: [],
            TargetBacklog: [],
            PlannedVelocity: [],
            ActualVelocity: [],
            CumulativePlannedVelocity: [],
            CumulativeActualVelocity: [],
            OptimisticProjectedVelocity: [],
            PessimisticProjectedVelocity: [],
            ProjectedFinishOptimisticIndex: -1,
            ProjectedFinishPessimisticIndex: -1,
            MostRecentBacklog: 0,
            BestHistoricalActualVelocity: 0,
            WorstHistoricalActualVelocity: 0,
            FirstPositiveVelocityIterationIndex: -1
        };

        // Get timebox info
        var current_iteration = this._current_iteration;
        var current_iteration_end_date;

        var current_release = this._release;
        var release_date = current_release.get('ReleaseDate');

        var today = new Date();

        if (current_iteration) {
            current_iteration_end_date = this._current_iteration.get('EndDate');
        }

        var planned_velocity_adder = 0;
        var actual_velocity_adder = 0;
        var best_historical_actual_velocity = 0;
        var worst_historical_actual_velocity = this._really_big_number;
        var most_recent_backlog = 0;

        // Assemble Actual and Planned velocity data
        // Assemble backlog data

        // Number of historical iterations in data set
        var number_iterations = me._iterations.length;
        var current_iteration_index = me._current_iteration_index;

        Ext.Array.each(me._iterations, function(iteration, iteration_index) {

            var this_end_date = iteration.get('EndDate');
            data.IterationEndDate.push(this_end_date);

            var backlog = me._getBacklogOnEndOfIteration(iteration);
            if (backlog) {
                most_recent_backlog = backlog;
            }
            data.TotalBacklog.push(backlog);

            var planned_velocity = iteration.get('PlannedVelocity') || 0;
            planned_velocity_adder += planned_velocity;

            var actual_velocity = me._velocities[iteration.get('Name')] || 0;
            actual_velocity_adder += actual_velocity;

            if ( actual_velocity > 0 && data.FirstPositiveVelocityIterationIndex === -1 ) {
                data.FirstPositiveVelocityIterationIndex = iteration_index;
            }
            data.Name.push(iteration.get('Name'));
            data.PlannedVelocity.push(planned_velocity);
            data.ActualVelocity.push(actual_velocity);

            data.CumulativePlannedVelocity.push(planned_velocity_adder);
            // Show null value for Cumulative Actual Velocity for sprints that have not yet occurred
            if (this_end_date > current_iteration_end_date) {
                actual_velocity_adder = null;
            }
            data.CumulativeActualVelocity.push(actual_velocity_adder);
        });

        data.MostRecentBacklog = most_recent_backlog;
        data.BestHistoricalActualVelocity = me._determineBestHistoricalActualVelocity(me._velocities);
        data.WorstHistoricalActualVelocity = me._determineWorstHistoricalActualVelocity(me._velocities);

        me._chart_data = data;
    },

    _assembleProjectedData: function() {

        var me = this;
        var data = this._chart_data;

        // Get timebox info
        var current_iteration = this._current_iteration;
        var current_iteration_end_date;

        var current_release = this._release;
        var release_date = current_release.get('ReleaseDate');

        var today = new Date();

        if (current_iteration) {
            current_iteration_end_date = this._current_iteration.get('EndDate');
        }

        // Add in the backlog target line and projected finish lines
        if (me._target_backlog === 0) {
            console.log("MRB", data.MostRecentBacklog);
            me._target_backlog = data.MostRecentBacklog;
            me._target_backlog_number_box.setValue(data.MostRecentBacklog);
        }

        var number_sprints_optimistic = Math.ceil(me._target_backlog/data.BestHistoricalActualVelocity);
        var number_sprints_pessimistic = Math.ceil(me._target_backlog/data.WorstHistoricalActualVelocity);

        me._log(['number_sprints_optimistic: ', number_sprints_optimistic,
            'number_sprints_pessimistic: ', number_sprints_pessimistic]);

        // when likely to finish (if starting at first positive sprint)
        data.ProjectedFinishOptimisticIndex = data.FirstPositiveVelocityIterationIndex + number_sprints_optimistic - 1;
        data.ProjectedFinishPessimisticIndex = data.FirstPositiveVelocityIterationIndex + number_sprints_pessimistic - 1 ;

        // If projections extend past our Release date, we need to
        // "pad" the data with fake iterations to plot projection
        var number_iterations_in_release = this._iterations.length - data.FirstPositiveVelocityIterationIndex;
        me._log(['number_iterations_in_release: ', number_iterations_in_release]);

        if (number_sprints_pessimistic >= number_iterations_in_release) {

            var extra_sprints = number_sprints_pessimistic - number_iterations_in_release;
            me._log(["extra_sprints: ", extra_sprints]);

            var ending_cumulative_planned_velocity = data.CumulativePlannedVelocity[number_iterations_in_release-1];
            var ending_planned_velocity = data.PlannedVelocity[number_iterations_in_release-1];
            var planned_velocity_adder = ending_cumulative_planned_velocity;

            var sprint_base_name = " Sprint";

            for (var i=0; i<=extra_sprints; i++) {
                var new_sprint_name = "+ " + (i + 1) + sprint_base_name;
                planned_velocity_adder += ending_planned_velocity;
                data.Name.push(new_sprint_name);
                data.TotalBacklog.push(null);
                data.PlannedVelocity.push(null);
                data.ActualVelocity.push(null);
                data.CumulativeActualVelocity.push(null);
                data.CumulativePlannedVelocity.push(null);
            }
        }

        // Now add in Optimistic/Pessimistic projected velocity data
        var optimistic_velocity_adder = 0;
        var pessimistic_velocity_adder = 0;

        Ext.Array.each(data.Name, function(iteration_name, iteration_index) {
            var cumulative_optimistic_velocity = null;
            var cumulative_pessimistic_velocity = null;

            if ( iteration_index >= data.FirstPositiveVelocityIterationIndex) {
                pessimistic_velocity_adder += data.WorstHistoricalActualVelocity;
                optimistic_velocity_adder += data.BestHistoricalActualVelocity;

                // Only show projections if we haven't released
                if (today < release_date) {
                    cumulative_optimistic_velocity = optimistic_velocity_adder;
                    cumulative_pessimistic_velocity = pessimistic_velocity_adder;
                }
            }

            data.OptimisticProjectedVelocity.push(cumulative_optimistic_velocity);
            data.PessimisticProjectedVelocity.push(cumulative_pessimistic_velocity);
        });

        me._chart_data = data;
    },

    _getBacklogOnEndOfIteration: function(iteration) {
        var backlog = null;
        var iteration_end = Rally.util.DateTime.toIsoString(iteration.get('EndDate'), true).replace(/T.*$/,"");
        // this._doubleLineLog("iteration_end", iteration_end);
        // this._doubleLineLog("release_flow_hash", this._release_flow_hash);
        if (this._release_flow_hash[iteration_end]) {
            backlog = this._release_flow_hash[iteration_end];
            // this._doubleLineLog("backlog", backlog);
        }
        return backlog;
    },

    _isSelectedReleaseCurrent: function() {
        var today = new Date();
        var this_release = this._release;
        var this_release_date = this_release.get('ReleaseDate');
        var this_release_start_date = this_release.get('ReleaseStartDate');
        this._log(["_isSelectedReleaseCurrent", (today > this_release_start_date && today <= this_release_date)]);
        return (today > this_release_start_date && today <= this_release_date);
    },

    _areBestWorstVelocityNonZero: function() {
        var data = this._chart_data;
        return (data.BestHistoricalActualVelocity > 0 && data.WorstHistoricalActualVelocity > 0);
    },

    // Function to find best historical sprint velocity for use in forecasting
    _determineBestHistoricalActualVelocity: function(velocity_hash) {
        var velocity = null;

        var velocities = [];
        for ( var i in velocity_hash ) {
            velocities.push(velocity_hash[i]);
        }

        if ( velocities.length > 0 ) {
            velocities.sort();
            var velocities_to_average = velocities;
            if ( velocities.length >= 3 ) {
                velocities_to_average = Ext.Array.slice(velocities, -3);
            }

            var best_velocity = 0;
            Ext.Array.each(velocities_to_average, function(this_velocity) {
                if (this_velocity > best_velocity) {
                    best_velocity = this_velocity;
                }
            });
            velocity = best_velocity;
            this._log(["best", velocity_hash, velocities, velocities_to_average, velocity]);
        }
        return velocity;
    },

    // Function to find worst historical sprint velocity for use in forecasting
    _determineWorstHistoricalActualVelocity: function(velocity_hash) {
        var velocity = null;

        var velocities = [];
        for ( var i in velocity_hash ) {
            velocities.push(velocity_hash[i]);
        }

        if ( velocities.length > 0 ) {
            velocities.sort();
            var velocities_to_average = velocities;
            var worst_velocity = this._really_big_number;
            Ext.Array.each(velocities_to_average, function(this_velocity) {
                if (this_velocity < worst_velocity) {
                    worst_velocity = this_velocity;
                }
            });
            velocity = worst_velocity;
            this._log(["worst", velocity_hash, velocities, velocities_to_average, velocity]);
        }
        return velocity;
    },

    _finished_all_asynchronous_calls: function() {
        var proceed = true;
        if (!this._asynch_return_flags["flows"]) {
            this._log("Not yet received the release cumulative flow data");
            proceed = false;
        }
        if (!this._asynch_return_flags["iterations"]) {
            this._log("Not yet received the iteration timebox data");
            proceed = false;
        }
        if (!this._asynch_return_flags["story_velocity"]) {
            this._log("Not yet received the story velocity data");
            proceed = false;
        }
        if (!this._asynch_return_flags["defect_velocity"]) {
            this._log("Not yet received the defect velocity data");
            proceed = false;
        }
        if (!this._asynch_return_flags["current_iteration"]) {
            this._log("Not yet received the Current Iteration");
            proceed = false;
        }
        if (!this._asynch_return_flags["story_backlog_today"]) {
            this._log("Not yet received today's story backlog");
            proceed = false;
        }
        if (!this._asynch_return_flags["defect_backlog_today"]) {
            this._log("Not yet received today's defect backlog");
            proceed = false;
        }
        if (!this._asynch_return_flags["aligned_releases"]) {
            this._log("Not yet received aligned releases");
            proceed = false;
        }
        if (!this._asynch_return_flags["aligned_iterations"]) {
            this._log("Not yet received aligned iterations");
            proceed = false;
        }
        return proceed;
    },

    _getPlotLines: function(data) {
        var plotlines = [];
        if ( data.ProjectedFinishPessimisticIndex === data.ProjectedFinishOptimisticIndex ) {
            plotlines = [
                {
                    color: '#0a0',
                    width: 2,
                    value: data.ProjectedFinishPessimisticIndex,
                    label: {
                        text: 'Projected Finish',
                        style: {
                            color: '#a00'
                        }
                    }
                }
            ];
        } else {
            plotlines = [
                {
                    color: '#a00',
                    width: 2,
                    value: data.ProjectedFinishPessimisticIndex,
                    label: {
                        text: 'Pessimistic Projected Finish',
                        style: {
                            color: '#a00'
                        }
                    }
                },
                {
                    color: '#0a0',
                    width: 2,
                    value: data.ProjectedFinishOptimisticIndex,
                    label: {
                        text: 'Optimistic Projected Finish',
                        style: {
                            color: '#0a0'
                        }
                    }
                }
            ];
        }
        return plotlines;
    },

    _makeChart: function() {
        var me = this;
        this._log("_makeChart");

        if ( this._finished_all_asynchronous_calls() ) {
            if (this._iterations.length === 0) {
                this._chart = this.down('#chart_box').add({
                    xtype: 'container',
                    html: 'No iterations defined in the release bounds...'
                });
            } else {
                this._assembleSprintData();

                // Only project if selected Release is current and we have velocity
                // history to use in projection
                if (this._isSelectedReleaseCurrent() && this._areBestWorstVelocityNonZero()) {
                    this._assembleProjectedData();
                }

                if ( this._chart ) {
                    this._chart.destroy();
                }

                var chart_hash = this._chart_data;

                this._log(chart_hash);
                this._chart = this.down('#chart_box').add({
                    xtype: 'rallychart',
                    chartData: {
                        categories: chart_hash.Name,
                        series: [
                            {
                                type: 'column',
                                data: chart_hash.CumulativePlannedVelocity,
                                name: 'Planned Velocity',
                                visible: true
                            },
                            /* --
                            {
                                type: 'line',
                                data: chart_hash.TotalBacklog,
                                name: 'Total Backlog',
                                visible: true
                            },
                            -- */
                            {
                                type: 'column',
                                data: chart_hash.CumulativeActualVelocity,
                                name: 'Actual Velocity',
                                visible: true
                            },
                            {
                                type: 'line',
                                data: chart_hash.OptimisticProjectedVelocity,
                                name: 'Optimistic Projected Velocity',
                                visible: true,
                                marker: {
                                    enabled: false
                                }
                            },
                            {
                                type: 'line',
                                data: chart_hash.PessimisticProjectedVelocity,
                                name: 'Pessimistic Projected Velocity',
                                color: '#0a0',
                                visible: true,
                                marker: {
                                    enabled: false
                                }
                            }/*,
                            {
                                type: 'line',
                                data: chart_hash.TargetBacklog,
                                name: 'Backlog Target',
                                visible: false,
                                marker: {
                                    enabled: false
                                }
                            }*/
                        ]
                    },
                    height: 350,
                    chartConfig: {
                        chart: {},
                        title: {
                            align: 'center'
                        },
                        yAxis: [
                            {
                                title: {
                                    enabled: true,
                                    text: 'Story Points',
                                    style: {
                                        fontWeight: 'normal'
                                    }
                                },
                                plotLines: [
                                    {
                                        color: '#000',
                                        width: 2,
                                        value: this._target_backlog,
                                        label: {
                                            text: 'Target Backlog (Points)',
                                            style: {
                                                color: '#000'
                                            }
                                        }
                                    }
                                ]
                            }
                        ],
                        xAxis: [
                            {
                                categories: chart_hash.Name,
                                plotLines: me._getPlotLines(chart_hash),
                                labels: {
                                    rotation: -45,
                                    align: 'right'
                                }
                            }
                        ]
                    }
                });
                this._chart.setChartColors(['#B5D8EB','#5C9ACB','#6ab17d','#f47168']);
            }
        }
    },

    _noIterationsNotify: function() {
        this._chart = this.down('#chart_box').add({
            xtype: 'container',
            html: "No Iterations Defined for Release at this Scoping."
        });
    },

    _log: function(msg) {
        window.console && console.log(msg);
    },

    _doubleLineLog: function(msg, variable) {
        if (this._debug) {
            console.log(msg);
            console.log(variable);
        }
    }

});