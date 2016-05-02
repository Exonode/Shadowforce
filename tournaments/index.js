'use strict';

const BRACKET_MINIMUM_UPDATE_INTERVAL = 2 * 1000;
const AUTO_DISQUALIFY_WARNING_TIMEOUT = 30 * 1000;
const AUTO_START_MINIMUM_TIMEOUT = 30 * 1000;
const MAX_REASON_LENGTH = 300;

let TournamentGenerators = {
	roundrobin: require('./generator-round-robin.js').RoundRobin,
	elimination: require('./generator-elimination.js').Elimination,
};

exports.tournaments = {};

function usersToNames(users) {
	return users.map(user => user.name);
}

class Tournament {
	constructor(room, format, generator, playerCap, isRated) {
		format = toId(format);

		this.id = room.id;
		this.room = room;
		this.title = Tools.getFormat(format).name + ' tournament';
		this.allowRenames = false;
		this.players = Object.create(null);
		this.playerCount = 0;
		this.playerCap = parseInt(playerCap) || Config.tournamentDefaultPlayerCap || 0;

		this.format = format;
		this.generator = generator;
		this.isRated = isRated;
		this.scouting = true;
		this.modjoin = false;
		this.autostartcap = false;
		if (Config.tournamentDefaultPlayerCap && this.playerCap > Config.tournamentDefaultPlayerCap) {
			Monitor.log('[TourMonitor] Room ' + room.id + ' starting a tour over default cap (' + this.playerCap + ')');
		}

		this.isBracketInvalidated = true;
		this.lastBracketUpdate = 0;
		this.bracketUpdateTimer = null;
		this.bracketCache = null;

		this.isTournamentStarted = false;
		this.availableMatches = null;
		this.inProgressMatches = null;

		this.isAvailableMatchesInvalidated = true;
		this.availableMatchesCache = null;

		this.pendingChallenges = null;
		this.autoDisqualifyTimeout = Infinity;
		this.autoDisqualifyTimer = null;

		this.isEnded = false;

		room.add('|tournament|create|' + this.format + '|' + generator.name + '|' + this.playerCap);
		room.send('|tournament|update|' + JSON.stringify({
			format: this.format,
			generator: generator.name,
			playerCap: this.playerCap,
			isStarted: false,
			isJoined: false,
		}));
		this.update();
	}

	setGenerator(generator, output) {
		if (this.isTournamentStarted) {
			output.sendReply('|tournament|error|BracketFrozen');
			return;
		}

		let isErrored = false;
		this.generator.getUsers().forEach(user => {
			let error = generator.addUser(user);
			if (typeof error === 'string') {
				output.sendReply('|tournament|error|' + error);
				isErrored = true;
			}
		});

		if (isErrored) return;

		this.generator = generator;
		this.room.send('|tournament|update|' + JSON.stringify({generator: generator.name}));
		this.isBracketInvalidated = true;
		this.update();
		return true;
	}

	forceEnd() {
		if (this.isTournamentStarted) {
			if (this.autoDisqualifyTimer) clearTimeout(this.autoDisqualifyTimer);
			this.inProgressMatches.forEach(match => {
				if (match) {
					delete match.room.tour;
					match.room.addRaw("<div class=\"broadcast-red\"><b>The tournament was forcefully ended.</b><br />You can finish playing, but this battle is no longer considered a tournament battle.</div>");
				}
			});
		} else if (this.autoStartTimeout) {
			clearTimeout(this.autoStartTimeout);
		}
		this.isEnded = true;
		this.room.add('|tournament|forceend');
		this.isEnded = true;
	}

	updateFor(targetUser, connection) {
		if (!connection) connection = targetUser;
		if (this.isEnded) return;
		if ((!this.bracketUpdateTimer && this.isBracketInvalidated) || (this.isTournamentStarted && this.isAvailableMatchesInvalidated)) {
			this.room.add(
				"Error: update() called with a target user when data invalidated: " +
				(!this.bracketUpdateTimer && this.isBracketInvalidated) + ", " +
				(this.isTournamentStarted && this.isAvailableMatchesInvalidated) +
				"; Please report this to an admin."
			);
			return;
		}
		let isJoined = this.generator.getUsers().indexOf(targetUser) >= 0;
		connection.sendTo(this.room, '|tournament|update|' + JSON.stringify({
			format: this.format,
			generator: this.generator.name,
			isStarted: this.isTournamentStarted,
			isJoined: isJoined,
			bracketData: this.bracketCache,
		}));
		if (this.isTournamentStarted && isJoined) {
			connection.sendTo(this.room, '|tournament|update|' + JSON.stringify({
				challenges: usersToNames(this.availableMatchesCache.challenges.get(targetUser)),
				challengeBys: usersToNames(this.availableMatchesCache.challengeBys.get(targetUser)),
			}));

			let pendingChallenge = this.pendingChallenges.get(targetUser);
			if (pendingChallenge && pendingChallenge.to) {
				connection.sendTo(this.room, '|tournament|update|' + JSON.stringify({challenging: pendingChallenge.to.name}));
			} else if (pendingChallenge && pendingChallenge.from) {
				connection.sendTo(this.room, '|tournament|update|' + JSON.stringify({challenged: pendingChallenge.from.name}));
			}
		}
		connection.sendTo(this.room, '|tournament|updateEnd');
	}

	update(targetUser) {
		if (targetUser) throw new Error("Please use updateFor() to update the tournament for a specific user.");
		if (this.isEnded) return;
		if (this.isBracketInvalidated) {
			if (Date.now() < this.lastBracketUpdate + BRACKET_MINIMUM_UPDATE_INTERVAL) {
				if (this.bracketUpdateTimer) clearTimeout(this.bracketUpdateTimer);
				this.bracketUpdateTimer = setTimeout(() => {
					this.bracketUpdateTimer = null;
					this.update();
				}, BRACKET_MINIMUM_UPDATE_INTERVAL);
			} else {
				this.lastBracketUpdate = Date.now();

				this.bracketCache = this.getBracketData();
				this.isBracketInvalidated = false;
				this.room.send('|tournament|update|' + JSON.stringify({bracketData: this.bracketCache}));
			}
		}

		if (this.isTournamentStarted && this.isAvailableMatchesInvalidated) {
			this.availableMatchesCache = this.getAvailableMatches();
			this.isAvailableMatchesInvalidated = false;

			this.availableMatchesCache.challenges.forEach((opponents, user) => {
				user.sendTo(this.room, '|tournament|update|' + JSON.stringify({challenges: usersToNames(opponents)}));
			});
			this.availableMatchesCache.challengeBys.forEach((opponents, user) => {
				user.sendTo(this.room, '|tournament|update|' + JSON.stringify({challengeBys: usersToNames(opponents)}));
			});
		}
		this.room.send('|tournament|updateEnd');
	}

	purgeGhostUsers() {
		// "Ghost" users sometimes end up in the tournament because they've merged with another user.
		// This function is to remove those ghost users from the tournament.
		this.generator.getUsers(true).forEach(user => {
			let realUser = Users.getExact(user.userid);
			if (!realUser || realUser !== user) {
				// The two following functions are called without their second argument,
				// but the second argument will not be used in this situation
				if (this.isTournamentStarted) {
					if (!this.disqualifiedUsers.get(user)) {
						this.disqualifyUser(user);
					}
				} else {
					this.removeUser(user);
				}
				this.room.update();
			}
		});
	}

	removeBannedUser(user) {
		if (this.generator.getUsers().indexOf(user) > -1) {
			if (this.isTournamentStarted) {
				if (!this.disqualifiedUsers.get(user)) {
					this.disqualifyUser(user, user, null);
				}
			} else {
				this.removeUser(user);
			}
			this.room.update();
		}
	}

	addUser(user, isAllowAlts, output) {
		if (!user.named) {
			output.sendReply('|tournament|error|UserNotNamed');
			return;
		}

		let users = this.generator.getUsers();
		if (this.playerCap && users.length >= this.playerCap) {
			output.sendReply('|tournament|error|Full');
			return;
		}

		if (!isAllowAlts) {
			for (let i = 0; i < users.length; i++) {
				if (users[i].latestIp === user.latestIp) {
					output.sendReply('|tournament|error|AltUserAlreadyAdded');
					return;
				}
			}
		}

		let error = this.generator.addUser(user);
		if (typeof error === 'string') {
			output.sendReply('|tournament|error|' + error);
			return;
		}

		this.room.add('|tournament|join|' + user.name);
		user.sendTo(this.room, '|tournament|update|{"isJoined":true}');
		this.isBracketInvalidated = true;
		this.update();
		if (this.playerCap === (users.length + 1)) {
			if (this.autostartcap === true) {
				this.startTournament(output);
			} else {
				this.room.add("The tournament is now full.");
			}
		}
	}
	removeUser(user, output) {
		let error = this.generator.removeUser(user);
		if (typeof error === 'string') {
			output.sendReply('|tournament|error|' + error);
			return;
		}

		this.room.add('|tournament|leave|' + user.name);
		user.sendTo(this.room, '|tournament|update|{"isJoined":false}');
		this.isBracketInvalidated = true;
		this.update();
	}
	replaceUser(user, replacementUser, output) {
		let error = this.generator.replaceUser(user, replacementUser);
		if (typeof error === 'string') {
			output.sendReply('|tournament|error|' + error);
			return;
		}

		this.room.add('|tournament|replace|' + user.name + '|' + replacementUser.name);
		user.sendTo(this.room, '|tournament|update|{"isJoined":false}');
		replacementUser.sendTo(this.room, '|tournament|update|{"isJoined":true}');
		this.isBracketInvalidated = true;
		this.update();
	}

	getBracketData() {
		let data = this.generator.getBracketData();
		if (data.type === 'tree') {
			if (!data.rootNode) {
				data.users = usersToNames(this.generator.getUsers().sort());
				return data;
			}
			let queue = [data.rootNode];
			while (queue.length > 0) {
				let node = queue.shift();

				if (node.state === 'available') {
					let pendingChallenge = this.pendingChallenges.get(node.children[0].team);
					if (pendingChallenge && node.children[1].team === pendingChallenge.to) {
						node.state = 'challenging';
					}

					let inProgressMatch = this.inProgressMatches.get(node.children[0].team);
					if (inProgressMatch && node.children[1].team === inProgressMatch.to) {
						node.state = 'inprogress';
						node.room = inProgressMatch.room.id;
					}
				}

				if (node.team) node.team = node.team.name;

				node.children.forEach(child => {
					queue.push(child);
				});
			}
		} else if (data.type === 'table') {
			if (this.isTournamentStarted) {
				data.tableContents.forEach((row, r) => {
					let pendingChallenge = this.pendingChallenges.get(data.tableHeaders.rows[r]);
					let inProgressMatch = this.inProgressMatches.get(data.tableHeaders.rows[r]);
					if (pendingChallenge || inProgressMatch) {
						row.forEach((cell, c) => {
							if (!cell) return;

							if (pendingChallenge && data.tableHeaders.cols[c] === pendingChallenge.to) {
								cell.state = 'challenging';
							}

							if (inProgressMatch && data.tableHeaders.cols[c] === inProgressMatch.to) {
								cell.state = 'inprogress';
								cell.room = inProgressMatch.room.id;
							}
						});
					}
				});
			}
			data.tableHeaders.cols = usersToNames(data.tableHeaders.cols);
			data.tableHeaders.rows = usersToNames(data.tableHeaders.rows);
		}
		return data;
	}

	startTournament(output) {
		if (this.isTournamentStarted) {
			output.sendReply('|tournament|error|AlreadyStarted');
			return false;
		}

		this.purgeGhostUsers();
		let users = this.generator.getUsers();
		if (users.length < 2) {
			output.sendReply('|tournament|error|NotEnoughUsers');
			return false;
		}

		if (this.generator.generateBracket) this.generator.generateBracket();
		this.generator.freezeBracket();

		this.availableMatches = new Map();
		this.inProgressMatches = new Map();
		this.pendingChallenges = new Map();
		this.disqualifiedUsers = new Map();
		this.isAutoDisqualifyWarned = new Map();
		this.lastActionTimes = new Map();
		users.forEach(user => {
			this.availableMatches.set(user, new Map());
			this.inProgressMatches.set(user, null);
			this.pendingChallenges.set(user, null);
			this.disqualifiedUsers.set(user, false);
			this.isAutoDisqualifyWarned.set(user, false);
			this.lastActionTimes.set(user, Date.now());
		});

		this.isTournamentStarted = true;
		if (this.autoStartTimeout) clearTimeout(this.autoStartTimeout);
		this.isBracketInvalidated = true;
		this.room.add('|tournament|start');
		this.room.send('|tournament|update|{"isStarted":true}');
		this.update();
		return true;
	}
	getAvailableMatches() {
		let matches = this.generator.getAvailableMatches();
		if (typeof matches === 'string') {
			this.room.add("Unexpected error from getAvailableMatches(): " + matches + ". Please report this to an admin.");
			return;
		}

		let users = this.generator.getUsers();
		let challenges = new Map();
		let challengeBys = new Map();
		let oldAvailableMatches = new Map();

		users.forEach(user => {
			challenges.set(user, []);
			challengeBys.set(user, []);

			let oldAvailableMatch = false;
			let availableMatches = this.availableMatches.get(user);
			if (availableMatches.size) {
				oldAvailableMatch = true;
				availableMatches.clear();
			}
			oldAvailableMatches.set(user, oldAvailableMatch);
		});

		matches.forEach(match => {
			challenges.get(match[0]).push(match[1]);
			challengeBys.get(match[1]).push(match[0]);

			this.availableMatches.get(match[0]).set(match[1], true);
		});

		this.availableMatches.forEach((availableMatches, user) => {
			if (oldAvailableMatches.get(user)) return;

			if (availableMatches.size) this.lastActionTimes.set(user, Date.now());
		});

		return {
			challenges: challenges,
			challengeBys: challengeBys,
		};
	}

	disqualifyUser(user, output, reason) {
		let error = this.generator.disqualifyUser(user);
		if (error) {
			output.sendReply('|tournament|error|' + error);
			return false;
		}
		if (this.disqualifiedUsers.get(user)) {
			output.sendReply('|tournament|error|AlreadyDisqualified');
			return false;
		}

		this.disqualifiedUsers.set(user, true);
		this.generator.setUserBusy(user, false);

		let challenge = this.pendingChallenges.get(user);
		if (challenge) {
			this.pendingChallenges.set(user, null);
			if (challenge.to) {
				this.generator.setUserBusy(challenge.to, false);
				this.pendingChallenges.set(challenge.to, null);
				challenge.to.sendTo(this.room, '|tournament|update|{"challenged":null}');
			} else if (challenge.from) {
				this.generator.setUserBusy(challenge.from, false);
				this.pendingChallenges.set(challenge.from, null);
				challenge.from.sendTo(this.room, '|tournament|update|{"challenging":null}');
			}
		}

		let matchFrom = this.inProgressMatches.get(user);
		if (matchFrom) {
			this.generator.setUserBusy(matchFrom.to, false);
			this.inProgressMatches.set(user, null);
			delete matchFrom.room.tour;
			matchFrom.room.battle.forfeit(user);
		}

		let matchTo = null;
		this.inProgressMatches.forEach((match, userFrom) => {
			if (match && match.to === user) matchTo = userFrom;
		});
		if (matchTo) {
			this.generator.setUserBusy(matchTo, false);
			let matchRoom = this.inProgressMatches.get(matchTo).room;
			delete matchRoom.tour;
			matchRoom.battle.forfeit(user);
			this.inProgressMatches.set(matchTo, null);
		}

		this.room.add('|tournament|disqualify|' + user.name);
		user.sendTo(this.room, '|tournament|update|{"isJoined":false}');
		if (reason !== null) user.popup("|modal|You have been disqualified from the tournament in " + this.room.title + (reason ? ":\n\n" + reason : "."));
		this.isBracketInvalidated = true;
		this.isAvailableMatchesInvalidated = true;

		if (this.generator.isTournamentEnded()) {
			this.onTournamentEnd();
		} else {
			this.update();
		}

		return true;
	}

	setAutoStartTimeout(timeout, output) {
		if (this.isTournamentStarted) {
			output.sendReply('|tournament|error|AlreadyStarted');
			return false;
		}
		timeout = parseFloat(timeout);
		if (timeout < AUTO_START_MINIMUM_TIMEOUT || isNaN(timeout)) {
			output.sendReply('|tournament|error|InvalidAutoStartTimeout');
			return false;
		}

		if (this.autoStartTimeout) clearTimeout(this.autoStartTimeout);
		if (timeout === Infinity) {
			this.room.add('|tournament|autostart|off');
		} else {
			this.autoStartTimeout = setTimeout(() => this.startTournament(output), timeout);
			this.room.add('|tournament|autostart|on|' + timeout);
		}

		return true;
	}

	setAutoDisqualifyTimeout(timeout, output) {
		if (timeout < AUTO_DISQUALIFY_WARNING_TIMEOUT || isNaN(timeout)) {
			output.sendReply('|tournament|error|InvalidAutoDisqualifyTimeout');
			return false;
		}

		this.autoDisqualifyTimeout = parseFloat(timeout);
		if (this.autoDisqualifyTimeout === Infinity) {
			this.room.add('|tournament|autodq|off');
		} else {
			this.room.add('|tournament|autodq|on|' + this.autoDisqualifyTimeout);
		}

		if (this.isTournamentStarted) this.runAutoDisqualify();
		return true;
	}
	runAutoDisqualify(output) {
		if (!this.isTournamentStarted) {
			output.sendReply('|tournament|error|NotStarted');
			return false;
		}
		if (this.autoDisqualifyTimer) clearTimeout(this.autoDisqualifyTimer);
		this.lastActionTimes.forEach((time, user) => {
			let availableMatches = false;
			if (this.availableMatches.get(user).size) availableMatches = true;
			let pendingChallenge = this.pendingChallenges.get(user);

			if (!availableMatches && !pendingChallenge) return;
			if (pendingChallenge && pendingChallenge.to) return;

			if (Date.now() > time + this.autoDisqualifyTimeout && this.isAutoDisqualifyWarned.get(user)) {
				this.disqualifyUser(user, output, "You failed to make or accept the challenge in time.");
				this.room.update();
			} else if (Date.now() > time + this.autoDisqualifyTimeout - AUTO_DISQUALIFY_WARNING_TIMEOUT && !this.isAutoDisqualifyWarned.get(user)) {
				let remainingTime = this.autoDisqualifyTimeout - Date.now() + time;
				if (remainingTime <= 0) {
					remainingTime = AUTO_DISQUALIFY_WARNING_TIMEOUT;
					this.lastActionTimes.set(user, Date.now() - this.autoDisqualifyTimeout + AUTO_DISQUALIFY_WARNING_TIMEOUT);
				}

				this.isAutoDisqualifyWarned.set(user, true);
				user.sendTo(this.room, '|tournament|autodq|target|' + remainingTime);
			} else {
				this.isAutoDisqualifyWarned.set(user, false);
			}
		});
		if (this.autoDisqualifyTimeout !== Infinity && !this.isEnded) this.autoDisqualifyTimer = setTimeout(() => this.runAutoDisqualify(), this.autoDisqualifyTimeout);
	}

	challenge(from, to, output) {
		if (!this.isTournamentStarted) {
			output.sendReply('|tournament|error|NotStarted');
			return;
		}

		if (!this.availableMatches.get(from) || !this.availableMatches.get(from).get(to)) {
			output.sendReply('|tournament|error|InvalidMatch');
			return;
		}

		if (this.generator.getUserBusy(from) || this.generator.getUserBusy(to)) {
			this.room.add("Tournament backend breaks specifications. Please report this to an admin.");
			return;
		}

		this.generator.setUserBusy(from, true);
		this.generator.setUserBusy(to, true);

		this.isAvailableMatchesInvalidated = true;
		this.purgeGhostUsers();
		this.update();

		from.prepBattle(this.format, 'tournament', from).then(result => this.finishChallenge(from, to, output, result));
	}
	finishChallenge(from, to, output, result) {
		if (!result) {
			this.generator.setUserBusy(from, false);
			this.generator.setUserBusy(to, false);

			this.isAvailableMatchesInvalidated = true;
			this.update();
			return;
		}

		this.lastActionTimes.set(from, Date.now());
		this.lastActionTimes.set(to, Date.now());
		this.pendingChallenges.set(from, {to: to, team: from.team});
		this.pendingChallenges.set(to, {from: from, team: from.team});
		from.sendTo(this.room, '|tournament|update|' + JSON.stringify({challenging: to.name}));
		to.sendTo(this.room, '|tournament|update|' + JSON.stringify({challenged: from.name}));

		this.isBracketInvalidated = true;
		this.update();
	}
	cancelChallenge(user, output) {
		if (!this.isTournamentStarted) {
			output.sendReply('|tournament|error|NotStarted');
			return;
		}

		let challenge = this.pendingChallenges.get(user);
		if (!challenge || challenge.from) return;

		this.generator.setUserBusy(user, false);
		this.generator.setUserBusy(challenge.to, false);
		this.pendingChallenges.set(user, null);
		this.pendingChallenges.set(challenge.to, null);
		user.sendTo(this.room, '|tournament|update|{"challenging":null}');
		challenge.to.sendTo(this.room, '|tournament|update|{"challenged":null}');

		this.isBracketInvalidated = true;
		this.isAvailableMatchesInvalidated = true;
		this.update();
	}
	acceptChallenge(user, output) {
		if (!this.isTournamentStarted) {
			output.sendReply('|tournament|error|NotStarted');
			return;
		}

		let challenge = this.pendingChallenges.get(user);
		if (!challenge || !challenge.from) return;

		user.prepBattle(this.format, 'tournament', user).then(result => this.finishAcceptChallenge(user, challenge, result));
	}
	finishAcceptChallenge(user, challenge, result) {
		if (!result) return;

		// Prevent battles between offline users from starting
		if (!challenge.from.connected || !user.connected) return;

		// Prevent double accepts and users that have been disqualified while between these two functions
		if (!this.pendingChallenges.get(challenge.from)) return;
		if (!this.pendingChallenges.get(user)) return;

		let room = Rooms.global.startBattle(challenge.from, user, this.format, challenge.team, user.team, {rated: this.isRated, tour: this});
		if (!room) return;

		this.pendingChallenges.set(challenge.from, null);
		this.pendingChallenges.set(user, null);
		challenge.from.sendTo(this.room, '|tournament|update|{"challenging":null}');
		user.sendTo(this.room, '|tournament|update|{"challenged":null}');

		this.inProgressMatches.set(challenge.from, {to: user, room: room});
		this.room.add('|tournament|battlestart|' + challenge.from.name + '|' + user.name + '|' + room.id).update();

		this.isBracketInvalidated = true;
		this.runAutoDisqualify(this.room);
		this.update();
	}
	onConnect(user, connection) {
		this.updateFor(user, connection);
	}
	onUpdateConnection(user, connection) {
		this.updateFor(user, connection);
	}
	onRename(user, oldid, joining) {
		this.updateFor(user);
	}
	onBattleJoin(room, user) {
		if (this.scouting || this.isEnded || user.latestIp === room.p1.latestIp || user.latestIp === room.p2.latestIp) return;
		let users = this.generator.getUsers(true);
		for (let i = 0; i < users.length; i++) {
			if (users[i].latestIp === user.latestIp) {
				return "Scouting is banned: tournament players can't watch other tournament battles.";
			}
		}
	}
	onBattleWin(room, winner) {
		let from = Users.get(room.p1);
		let to = Users.get(room.p2);

		let result = 'draw';
		if (from === winner) {
			result = 'win';
		} else if (to === winner) {
			result = 'loss';
		}

		if (result === 'draw' && !this.generator.isDrawingSupported) {
			this.room.add('|tournament|battleend|' + from.name + '|' + to.name + '|' + result + '|' + room.battle.score.join(',') + '|fail');

			this.generator.setUserBusy(from, false);
			this.generator.setUserBusy(to, false);
			this.inProgressMatches.set(from, null);

			this.isBracketInvalidated = true;
			this.isAvailableMatchesInvalidated = true;

			this.runAutoDisqualify();
			this.update();
			return this.room.update();
		}

		let error = this.generator.setMatchResult([from, to], result, room.battle.score);
		if (error) {
			// Should never happen
			return this.room.add("Unexpected " + error + " from setMatchResult([" + from.userid + ", " + to.userid + "], " + result + ", " + room.battle.score + ") in onBattleWin(" + room.id + ", " + winner.userid + "). Please report this to an admin.").update();
		}

		this.room.add('|tournament|battleend|' + from.name + '|' + to.name + '|' + result + '|' + room.battle.score.join(','));

		this.generator.setUserBusy(from, false);
		this.generator.setUserBusy(to, false);
		this.inProgressMatches.set(from, null);

		this.isBracketInvalidated = true;
		this.isAvailableMatchesInvalidated = true;

		if (this.generator.isTournamentEnded()) {
			this.onTournamentEnd();
		} else {
			this.runAutoDisqualify();
			this.update();
		}
		this.room.update();
	}
	onTournamentEnd() {
		this.room.add('|tournament|end|' + JSON.stringify({
			results: this.generator.getResults().map(usersToNames),
			format: this.format,
			generator: this.generator.name,
			bracketData: this.getBracketData(),
		}));
		this.isEnded = true;
		if (this.autoDisqualifyTimer) clearTimeout(this.autoDisqualifyTimer);

		//
		// Tournament Winnings
		//

		let color = '#088cc7';
		let sizeRequiredToEarn = 4;
		let currencyName = function (amount) {
			let name = " buck";
			return amount === 1 ? name : name + "s";
		};
		let data = this.generator.getResults().map(usersToNames).toString();
		let winner, runnerUp;

		if (data.indexOf(',') >= 0) {
			data = data.split(',');
			winner = data[0];
			if (data[1]) runnerUp = data[1];
		} else {
			winner = data;
		}

		let wid = toId(winner);
		let rid = toId(runnerUp);
		let tourSize = this.generator.users.size;

		if (this.room.isOfficial && tourSize >= sizeRequiredToEarn) {
			let firstMoney = Math.round(tourSize / 4);
			let secondMoney = Math.round(firstMoney / 2);

			Db('money').set(wid, Db('money').get(wid, 0) + firstMoney);
			this.room.addRaw("<b><font color='" + color + "'>" + Tools.escapeHTML(winner) + "</font> has won " + "<font color='" + color + "'>" + firstMoney + "</font>" + currencyName(firstMoney) + " for winning the tournament!</b>");

			if (runnerUp) {
				Db('money').set(rid, Db('money').get(rid, 0) + secondMoney);
				this.room.addRaw("<b><font color='" + color + "'>" + Tools.escapeHTML(runnerUp) + "</font> has won " +  "<font color='" + color + "'>" + secondMoney + "</font>" + currencyName(secondMoney) + " for winning the tournament!</b>");
			}
		}
		delete exports.tournaments[this.room.id];
		delete this.room.game;
	}
}

function createTournamentGenerator(generator, args, output) {
	let Generator = TournamentGenerators[toId(generator)];
	if (!Generator) {
		output.errorReply(generator + " is not a valid type.");
		output.errorReply("Valid types: " + Object.keys(TournamentGenerators).join(", "));
		return;
	}
	args.unshift(null);
	return new (Generator.bind.apply(Generator, args))();
}
function createTournament(room, format, generator, playerCap, isRated, args, output) {
	if (room.type !== 'chat') {
		output.errorReply("Tournaments can only be created in chat rooms.");
		return;
	}
	if (room.game) {
		output.errorReply("You cannot have a tournament until the current room activity is over: " + room.game.title);
		return;
	}
	if (Rooms.global.lockdown) {
		output.errorReply("The server is restarting soon, so a tournament cannot be created.");
		return;
	}
	format = Tools.getFormat(format);
	if (format.effectType !== 'Format' || !format.tournamentShow) {
		output.errorReply(format.id + " is not a valid tournament format.");
		output.errorReply("Valid formats: " + Object.values(Tools.data.Formats).filter(f => f.effectType === 'Format' && f.tournamentShow).map(format => format.name).join(", "));
		return;
	}
	if (!TournamentGenerators[toId(generator)]) {
		output.errorReply(generator + " is not a valid type.");
		output.errorReply("Valid types: " + Object.keys(TournamentGenerators).join(", "));
		return;
	}
	if (playerCap && playerCap < 2) {
		output.errorReply("You cannot have a player cap that is less than 2.");
		return;
	}
	return (room.game = exports.tournaments[room.id] = new Tournament(room, format, createTournamentGenerator(generator, args, output), playerCap, isRated));
}
function deleteTournament(id, output) {
	let tournament = exports.tournaments[id];
	if (!tournament) {
		output.errorReply(id + " doesn't exist.");
		return false;
	}
	tournament.forceEnd(output);
	delete exports.tournaments[id];
	let room = Rooms(id);
	if (room) delete room.game;
	return true;
}
function getTournament(id, output) {
	if (exports.tournaments[id]) {
		return exports.tournaments[id];
	}
}

let commands = {
	basic: {
		j: 'join',
		in: 'join',
		join: function (tournament, user) {
			tournament.addUser(user, false, this);
		},
		l: 'leave',
		out: 'leave',
		leave: function (tournament, user) {
			if (tournament.isTournamentStarted) {
				tournament.disqualifyUser(user, this);
			} else {
				tournament.removeUser(user, this);
			}
		},
		getusers: function (tournament) {
			if (!this.canBroadcast()) return;
			let users = usersToNames(tournament.generator.getUsers(true).sort());
			this.sendReplyBox("<strong>" + users.length + " users remain in this tournament:</strong><br />" + Tools.escapeHTML(users.join(", ")));
		},
		getupdate: function (tournament, user) {
			tournament.updateFor(user);
			this.sendReply("Your tournament bracket has been updated.");
		},
		challenge: function (tournament, user, params, cmd) {
			if (params.length < 1) {
				return this.sendReply("Usage: " + cmd + " <user>");
			}
			let targetUser = Users.get(params[0]);
			if (!targetUser) {
				return this.errorReply("User " + params[0] + " not found.");
			}
			tournament.challenge(user, targetUser, this);
		},
		cancelchallenge: function (tournament, user) {
			tournament.cancelChallenge(user, this);
		},
		acceptchallenge: function (tournament, user) {
			tournament.acceptChallenge(user, this);
		},
	},
	creation: {
		settype: function (tournament, user, params, cmd) {
			if (params.length < 1) {
				return this.sendReply("Usage: " + cmd + " <type> [, <comma-separated arguments>]");
			}
			let playerCap = parseInt(params.splice(1, 1));
			let generator = createTournamentGenerator(params.shift(), params, this);
			if (generator && tournament.setGenerator(generator, this)) {
				if (playerCap && playerCap >= 2) {
					tournament.playerCap = playerCap;
					if (Config.tournamentDefaultPlayerCap && tournament.playerCap > Config.tournamentDefaultPlayerCap) {
						Monitor.log('[TourMonitor] Room ' + tournament.room.id + ' starting a tour over default cap (' + tournament.playerCap + ')');
					}
				}
				this.sendReply("Tournament set to " + generator.name + (playerCap ? " with a player cap of " + tournament.playerCap : "") + ".");
			}
		},
		end: 'delete',
		stop: 'delete',
		delete: function (tournament, user) {
			if (deleteTournament(tournament.room.id, this)) {
				this.privateModCommand("(" + user.name + " forcibly ended a tournament.)");
			}
		},
	},
	moderation: {
		begin: 'start',
		start: function (tournament, user) {
			if (tournament.startTournament(this)) {
				this.sendModCommand("(" + user.name + " started the tournament.)");
			}
		},
		dq: 'disqualify',
		disqualify: function (tournament, user, params, cmd) {
			if (params.length < 1) {
				return this.sendReply("Usage: " + cmd + " <user>");
			}
			let targetUser = Users.get(params[0]);
			if (!targetUser) {
				return this.errorReply("User " + params[0] + " not found.");
			}
			let reason = '';
			if (params[1]) {
				reason = params[1].trim();
				if (reason.length > MAX_REASON_LENGTH) return this.errorReply("The reason is too long. It cannot exceed " + MAX_REASON_LENGTH + " characters.");
			}
			if (tournament.disqualifyUser(targetUser, this, reason)) {
				this.privateModCommand("(" + targetUser.name + " was disqualified from the tournament by " + user.name + (reason ? " (" + reason + ")" : "") + ")");
			}
		},
		autostart: 'setautostart',
		setautostart: function (tournament, user, params, cmd) {
			if (params.length < 1) {
				return this.sendReply("Usage: " + cmd + " <on|minutes|off>");
			}
			let option = params[0].toLowerCase();
			if (option === 'on' || option === 'true' || option === 'start') {
				if (tournament.isTournamentStarted) {
					return this.sendReply("The tournament has already started.");
				} else {
					tournament.autostartcap = true;
					this.room.add("The tournament will start when the player cap is reached.");
					this.privateModCommand("(The tournament was set to autostart when the player cap is reached by " + user.name + ")");
				}
			} else {
				if (option === '0' || option === 'infinity' || option === 'off' || option === 'false' || option === 'stop' || option === 'remove') {
					if (!tournament.autostartcap) return this.errorReply("The tournament autostart cap is already disabled for this tournament.");
					params[0] = 'off';
					tournament.autostartcap = false;
				}
				let timeout = params[0].toLowerCase() === 'off' ? Infinity : params[0];
				if (tournament.setAutoStartTimeout(timeout * 60 * 1000, this)) {
					this.privateModCommand("(The tournament auto start timeout was set to " + params[0] + " by " + user.name + ")");
				}
			}
		},
		autodq: 'setautodq',
		setautodq: function (tournament, user, params, cmd) {
			if (params.length < 1) {
				if (tournament.autoDisqualifyTimeout !== Infinity) {
					return this.sendReply("Usage: " + cmd + " <minutes|off>; The current automatic disqualify timer is set to " + (tournament.autoDisqualifyTimeout / 1000 / 60) + " minutes");
				} else {
					return this.sendReply("Usage: " + cmd + " <minutes|off>");
				}
			}
			if (params[0].toLowerCase() === 'infinity' || params[0] === '0') params[0] = 'off';
			let timeout = params[0].toLowerCase() === 'off' ? Infinity : params[0] * 60 * 1000;
			if (timeout === tournament.autoDisqualifyTimeout) return this.errorReply("The automatic tournament disqualify timer is already set to " + params[0] + " minutes.");
			if (tournament.setAutoDisqualifyTimeout(timeout, this)) {
				this.privateModCommand("(The tournament auto disqualify timer was set to " + params[0] + " by " + user.name + ")");
			}
		},
		runautodq: function (tournament) {
			tournament.runAutoDisqualify(this);
		},
		scout: 'setscouting',
		scouting: 'setscouting',
		setscout: 'setscouting',
		setscouting: function (tournament, user, params, cmd) {
			if (params.length < 1) {
				if (tournament.scouting) {
					return this.sendReply("This tournament allows spectating other battles while in a tournament.");
				} else {
					return this.sendReply("This tournament disallows spectating other battles while in a tournament.");
				}
			}

			let option = params[0].toLowerCase();
			if (option === 'on' || option === 'true' || option === 'allow' || option === 'allowed') {
				if (tournament.scouting) return this.errorReply("Scouting for this tournament is already set to allowed.");
				tournament.scouting = true;
				tournament.modjoin = false;
				this.room.add('|tournament|scouting|allow');
				this.privateModCommand("(The tournament was set to allow scouting by " + user.name + ")");
			} else if (option === 'off' || option === 'false' || option === 'disallow' || option === 'disallowed') {
				if (!tournament.scouting) return this.errorReply("Scouting for this tournament is already disabled.");
				tournament.scouting = false;
				tournament.modjoin = true;
				this.room.add('|tournament|scouting|disallow');
				this.privateModCommand("(The tournament was set to disallow scouting by " + user.name + ")");
			} else {
				return this.sendReply("Usage: " + cmd + " <allow|disallow>");
			}
		},
		modjoin: 'setmodjoin',
		setmodjoin: function (tournament, user, params, cmd) {
			if (params.length < 1) {
				if (tournament.modjoin) {
					return this.sendReply("This tournament allows players to modjoin their battles.");
				} else {
					return this.sendReply("This tournament does not allow players to modjoin their battles.");
				}
			}

			let option = params[0].toLowerCase();
			if (option === 'on' || option === 'true' || option === 'allow' || option === 'allowed') {
				if (tournament.modjoin) return this.errorReply("Modjoining is already allowed for this tournament.");
				tournament.modjoin = true;
				this.room.add('Modjoining is now allowed (Players can modjoin their tournament battles).');
				this.privateModCommand("(The tournament was set to allow modjoin by " + user.name + ")");
			} else if (option === 'off' || option === 'false' || option === 'disallow' || option === 'disallowed') {
				if (!tournament.modjoin) return this.errorReply("Modjoining is already not allowed for this tournament.");
				tournament.modjoin = false;
				this.room.add('Modjoining is now banned (Players cannot modjoin their tournament battles).');
				this.privateModCommand("(The tournament was set to disallow modjoin by " + user.name + ")");
			} else {
				return this.sendReply("Usage: " + cmd + " <allow|disallow>");
			}
		},
	},
};

CommandParser.commands.tour = 'tournament';
CommandParser.commands.tours = 'tournament';
CommandParser.commands.tournaments = 'tournament';
CommandParser.commands.tournament = function (paramString, room, user) {
	let cmdParts = paramString.split(' ');
	let cmd = cmdParts.shift().trim().toLowerCase();
	let params = cmdParts.join(' ').split(',').map(param => param.trim());
	if (!params[0]) params = [];

	if (cmd === '') {
		if (!this.canBroadcast()) return;
		this.sendReply('|tournaments|info|' + JSON.stringify(Object.keys(exports.tournaments).filter(tournament => {
			tournament = exports.tournaments[tournament];
			return !tournament.room.isPrivate && !tournament.room.isPersonal && !tournament.room.staffRoom;
		}).map(tournament => {
			tournament = exports.tournaments[tournament];
			return {room: tournament.room.id, format: tournament.format, generator: tournament.generator.name, isStarted: tournament.isTournamentStarted};
		})));
	} else if (cmd === 'help') {
		return this.parse('/help tournament');
	} else if (cmd === 'on' || cmd === 'enable') {
		if (!this.can('tournamentsmanagement', null, room)) return;
		if (room.toursEnabled) {
			return this.sendReply("Tournaments are already enabled.");
		}
		room.toursEnabled = true;
		if (room.chatRoomData) {
			room.chatRoomData.toursEnabled = true;
			Rooms.global.writeChatRoomData();
		}
		return this.sendReply("Tournaments enabled.");
	} else if (cmd === 'off' || cmd === 'disable') {
		if (!this.can('tournamentsmanagement', null, room)) return;
		if (!room.toursEnabled) {
			return this.sendReply("Tournaments are already disabled.");
		}
		delete room.toursEnabled;
		if (room.chatRoomData) {
			delete room.chatRoomData.toursEnabled;
			Rooms.global.writeChatRoomData();
		}
		return this.sendReply("Tournaments disabled.");
	} else if (cmd === 'announce' || cmd === 'announcements') {
		if (!this.can('tournamentsmanagement', null, room)) return;
		if (Config.tourannouncements.indexOf(room.id) < 0) {
			return this.sendReply("Tournaments in this room cannot be announced.");
		}
		if (params.length < 1) {
			if (room.tourAnnouncements) {
				return this.sendReply("Tournament announcements are enabled.");
			} else {
				return this.sendReply("Tournament announcements are disabled.");
			}
		}

		let option = params[0].toLowerCase();
		if (option === 'on' || option === 'enable') {
			if (room.tourAnnouncements) return this.errorReply("Tournament announcements are already enabled.");
			room.tourAnnouncements = true;
			this.privateModCommand("(Tournament announcements were enabled by " + user.name + ")");
		} else if (option === 'off' || option === 'disable') {
			if (!room.tourAnnouncements) return this.errorReply("Tournament announcements are already disabled.");
			room.tourAnnouncements = false;
			this.privateModCommand("(Tournament announcements were disabled by " + user.name + ")");
		} else {
			return this.sendReply("Usage: " + cmd + " <on|off>");
		}

		if (room.chatRoomData) {
			room.chatRoomData.tourAnnouncements = room.tourAnnouncements;
			Rooms.global.writeChatRoomData();
		}
	} else if (cmd === 'create' || cmd === 'new') {
		if (room.toursEnabled) {
			if (!this.can('tournaments', null, room)) return;
		} else {
			if (!user.can('tournamentsmanagement', null, room)) {
				return this.errorReply("Tournaments are disabled in this room (" + room.id + ").");
			}
		}
		if (params.length < 2) {
			return this.sendReply("Usage: " + cmd + " <format>, <type> [, <comma-separated arguments>]");
		}

		let tour = createTournament(room, params.shift(), params.shift(), params.shift(), Config.istournamentsrated, params, this);
		if (tour) {
			this.privateModCommand("(" + user.name + " created a tournament in " + tour.format + " format.)");
			if (room.tourAnnouncements) {
				let tourRoom = Rooms.search(Config.tourroom || 'tournaments');
				if (tourRoom && tourRoom !== room) tourRoom.addRaw('<div class="infobox"><a href="/' + room.id + '" class="ilink"><strong>' + Tools.escapeHTML(Tools.getFormat(tour.format).name) + '</strong> tournament created in <strong>' + Tools.escapeHTML(room.title) + '</strong>.</a></div>').update();
			}
		}
	} else {
		let tournament = getTournament(room.id);
		if (!tournament) {
			return this.sendReply("There is currently no tournament running in this room.");
		}

		let commandHandler = null;
		if (commands.basic[cmd]) {
			commandHandler = typeof commands.basic[cmd] === 'string' ? commands.basic[commands.basic[cmd]] : commands.basic[cmd];
		}

		if (commands.creation[cmd]) {
			if (room.toursEnabled) {
				if (!this.can('tournaments', null, room)) return;
			} else {
				if (!user.can('tournamentsmanagement', null, room)) {
					return this.errorReply("Tournaments are disabled in this room (" + room.id + ").");
				}
			}
			commandHandler = typeof commands.creation[cmd] === 'string' ? commands.creation[commands.creation[cmd]] : commands.creation[cmd];
		}

		if (commands.moderation[cmd]) {
			if (!user.can('tournamentsmoderation', null, room)) {
				return this.errorReply(cmd + " -  Access denied.");
			}
			commandHandler = typeof commands.moderation[cmd] === 'string' ? commands.moderation[commands.moderation[cmd]] : commands.moderation[cmd];
		}

		if (!commandHandler) {
			this.errorReply(cmd + " is not a tournament command.");
		} else {
			commandHandler.call(this, tournament, user, params, cmd);
		}
	}
};
CommandParser.commands.tournamenthelp = function (target, room, user) {
	if (!this.canBroadcast()) return;
	return this.sendReplyBox(
		"- create/new &lt;format>, &lt;type> [, &lt;comma-separated arguments>]: Creates a new tournament in the current room.<br />" +
		"- settype &lt;type> [, &lt;comma-separated arguments>]: Modifies the type of tournament after it's been created, but before it has started.<br />" +
		"- end/stop/delete: Forcibly ends the tournament in the current room.<br />" +
		"- begin/start: Starts the tournament in the current room.<br />" +
		"- autostart/setautostart &lt;on|minutes|off>: Sets the automatic start timeout.<br />" +
		"- dq/disqualify &lt;user>: Disqualifies a user.<br />" +
		"- autodq/setautodq &lt;minutes|off>: Sets the automatic disqualification timeout.<br />" +
		"- runautodq: Manually run the automatic disqualifier.<br />" +
		"- scouting &lt;allow|disallow>: Specifies whether joining tournament matches while in a tournament is allowed.<br />" +
		"- modjoin &lt;allow|disallow>: Specifies whether players can modjoin their battles.<br />" +
		"- getusers: Lists the users in the current tournament.<br />" +
		"- on/off: Enables/disables allowing mods to start tournaments in the current room.<br />" +
		"- announce/announcements &lt;on|off>: Enables/disables tournament announcements for the current room.<br />" +
		"More detailed help can be found <a href=\"https://gist.github.com/sirDonovan/130324abcd06254cf501\">here</a>"
	);
};

exports.Tournament = Tournament;
exports.TournamentGenerators = TournamentGenerators;

exports.createTournament = createTournament;
exports.deleteTournament = deleteTournament;
exports.get = getTournament;

exports.commands = commands;
