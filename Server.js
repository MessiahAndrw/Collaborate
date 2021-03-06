﻿/*****************************************************************************
Socket

Contains code for hosting the server and handling connections and messages.

******************************************************************************/
var app = require('express')();
var server = require('http').createServer(app);
var io = require('socket.io').listen(server);

var Database = require('./Database.js');
var Discussions = require('./Discussions.js');
var Pages = require('./Pages.js');
var Settings = require('./Settings.js');
var Users = require('./Users.js');

// global settings for the Wiki (sent to the user)
exports.globalSettings = {
    // The wiki name (appears at the top of the wiki)
    communityName: null,
    // Welcome message that appears on the home page
    welcomeMessage: null,
    // Can users access the site without being logged in?
    publicAccess: null
};

// global settings for the Wiki (not sent to the user)
exports.globalServerSettings = {
    // The port we should run the wiki on
    port: null,
    // The address that emails coming from the Wiki come from
    emailAddress: null,
    // The address that users can access this site at (for sending out links via email)
    siteAddress: null
};

// register site handlers
app.get('/', function(req, res) {
    res.sendfile('client/index.html');
});

app.get(/\/client\/(.*)/, function(req, res) {
    res.sendfile('client/' + req.params[0]);
});

// start the server
exports.initialize = function() {
    // load in settings
    Settings.initialize(function() {
        // grab the ones we're interested in
        exports.globalSettings.communityName = Settings.getSetting('community_name');
        exports.globalSettings.welcomeMessage = Settings.getSetting('welcome_message');
        exports.globalSettings.publicAccess = Settings.getSetting('public_access') === 'true';

        exports.globalServerSettings.emailAddress = Settings.getSetting('email_address');
        exports.globalServerSettings.port = Settings.getSetting('port') | 0;

        Discussions.initialize();

        // start the server
        server.listen(exports.globalServerSettings.port);
        console.log("Listening on port " + exports.globalServerSettings.port);
    });
};

// called when a new socket connection is initialized
io.sockets.on('connection', function(socket) {
    // socket not logged in:
    socket.loggedIn = false;

    // socket id
    socket.userid = "";

    // send global settings
    socket.emit('globalSettings', exports.globalSettings);

    // user requests global user settings
    socket.on('getGlobalUserSettings', function() {
        // send the global user settings
        socket.emit('globalUserSettings', Users.globalSettings);
    });

    // user requests login
    socket.on('login', function(data) {
        // check params were passed in
        if(typeof data !== 'object' || data.username === undefined || data.password === undefined) {
            socket.emit("loginResponse", { status: "nouser" });
            return;
        }

        // already logged in?
        if(socket.loggedIn == true)
            return;

        // authenticate
        Users.authenticate(data.username, data.password, function(response) {
            if(response.status === "success") {
                // save user info on socket if successful
                socket.loggedIn = true;
                socket.userid = response.userid;
                socket.forumAdmin = response.forumAdmin;
                socket.forumModerator = response.forumModerator;
            }
            socket.emit("loginResponse", response);
        });
    });

    // user requests to create a user
    socket.on('createUser', function(data) {
        // check params were passed in
        if(typeof data !== 'object' || data.username === undefined || data.realname === undefined || data.email === undefined
            // cannot register if we are already logged in
            || socket.loggedIn == true) {
            socket.emit("createUserResponse", { status: "badusername" });
        }

        // create the user
        Users.createUser(data.username, data.realname, data.email, function(response) {
            socket.emit("createUserResponse", response);
        });
    });

    // user requests to resend their verification email
    socket.on('resendVerificationEmail', function(data) {
        // check params were passed in
        if(typeof data !== 'object' || data.username === undefined || socket.loggedIn == true) {
            return;
        }

        Users.resendVerificationEmail(data.username);
    });

    // user tries to verify their email address
    socket.on('verifyEmail', function(data) {
        // check params were passed in
        if(typeof data !== 'object' || data.username === undefined || data.token === undefined || socket.loggedIn == true) {
            socket.emit("verifyEmailResponse", { status: "badcode" });
            return;
        }

        Users.verifyEmail(data.username, data.token, function(response) {
            socket.emit("verifyEmailResponse", response);
        });
    });

    // log the user out
    var logout = function() {
        // not logged in?
        if(socket.loggedIn == false) 
            return;
        socket.loggedIn = false;
        socket.userid = "";
        socket.username = "";
    };

    // user requests logout
    socket.on('logout', function() {
        logout();
    });

    // the user disconnects
    socket.on('disconnect', function() {
        logout();
    });

    socket.on('loadHomePage', function() {
        Discussions.getRecentThreads(function(status, result) {
            socket.emit('loadHomePageResponse', {
                        threads: result
            });
        });
    });

    // get recent threads
    socket.on('recentThreads', function() {
        if(socket.isLoggedIn == false && !exports.globalSettings.publicAccess)
            return;

        Discussions.getRecentThreads(function(status, result) {
            if(status !== "success") return;

            socket.emit('recentThreadsResponse', {
                threads: result,
            });
        });
    });

    // load discussions, getting recent threads, posts, discussion forums
    socket.on('loadDiscussions', function() {
        if(socket.isLoggedIn == false && !exports.globalSettings.publicAccess)
            return;

        Discussions.getRecentThreads(function(status, result1) {
            if(status !== "success") return;

            Discussions.getRecentPosts(function(status, result2) {
                if(status !== "success") return;

                Discussions.getDiscussionForums(function(status, result3) {
                    if(status !== "success") return;

                    socket.emit('loadDiscussionsResponse', {
                        threads: result1,
                        posts: result2,
                        forums: result3
                    });
                });
            });
        });
    });

    // create a new forum
    socket.on('createDiscussionForum', function(data) {
        if(socket.isLoggedIn == false || typeof data !== 'object' || typeof data.title !== 'string')
            return;
        
        if(socket.forumAdmin !== true) {
            socket.emit("createDiscussionForumResponse", {status: "nopermission"});
            return;
        }

        var title = data.title.trim();
        if(title.length == 0) {
            socket.emit("createDiscussionForumResponse", {status: "badname"});
            return;
        }

        Discussions.createDiscussionForum(title, function(status, result1) {
            if(status !== "success") {
                socket.emit("createDiscussionForumResponse", {status: status});
                return;
            }

            Discussions.getDiscussionForums(function(status, result2) {
                    if(status !== "success") {
                        socket.emit("createDiscussionForumResponse", {status: status});
                        return;
                    }

                    socket.emit('createDiscussionForumResponse', {
                        status: "success",
                        forums: result2
                    });
                });
        });
    });

    // set the discussion forum's title
    socket.on('setDiscussionForumTitle', function(data) {
        if(socket.isLoggedIn == false || typeof data !== 'object' || typeof data.title !== 'string' || data.id === undefined)
            return;
        
        if(socket.forumAdmin !== true) {
            socket.emit("setDiscussionForumTitleResponse", {status: "nopermission"});
            return;
        }

        var title = data.title.trim();
        if(title.length == 0) {
            socket.emit("setDiscussionForumTitleResponse", {status: "badname"});
            return;
        }

        Discussions.setDiscussionForumTitle(data.id, title, function(status, result1) {
            if(status !== "success") {
                socket.emit("setDiscussionForumTitleResponse", {status: status});
                return;
            }

            Discussions.getDiscussionForums(function(status, result2) {
                    if(status !== "success") {
                        socket.emit("setDiscussionForumTitleResponse", {status: status});
                        return;
                    }

                    socket.emit('setDiscussionForumTitleResponse', {
                        status: "success",
                        forums: result2
                    });
                });
        });
    });

    // delete a discussion forum
    socket.on('deleteDiscussionForum', function(data) {
        if(socket.isLoggedIn == false || typeof data !== 'object' || data.id === undefined)
            return;
        
        if(socket.forumAdmin !== true) {
            socket.emit("deleteDiscussionForumResponse", {status: "nopermission"});
            return;
        }

        Discussions.deleteDiscussionForum(data.id, function(status, result1) {
            if(status !== "success") {
                socket.emit("deleteDiscussionForumResponse", {status: status});
                return;
            }

            Discussions.getDiscussionForums(function(status, result2) {
                    if(status !== "success") {
                        socket.emit("deleteDiscussionForumResponse", {status: status});
                        return;
                    }

                    socket.emit('deleteDiscussionForumResponse', {
                        status: "success",
                        forums: result2
                    });
                });
        });
    });

    /*
    // user tries to load a page
    socket.on('loadPage', function() {
        // if not logged in and non anonymous access, can't load page
        if(socket.loggedIn == false && !exports.globalSettings.publicAccess)
            return;
        
        // test parameters
        if(typeof data !== 'object' || data.path === undefined || data.redirect === undefined)
            return;
        
        // request the page
        Pages.loadPage(socket.userid, data.path, data.redirect, function(result) {
            // return the result
            socket.emit('loadPageResult', result);
        });
    });

    // user tries to create a page
    socket.on('createPage', function(data) {
        // must be logged in
        if(socket.loggedIn == false)
            return;

        // test parameters
        if(typeof data !== 'object' || data.path === undefined)
            return;
        
        // create the page
        Pages.createPage(socket.userid, data.path, function(result) {
            // return the result
            socket.emit('createPageResult', result);
        });
    });*/
});