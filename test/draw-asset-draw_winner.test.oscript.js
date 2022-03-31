// uses `aa-testkit` testing framework for AA tests. Docs can be found here `https://github.com/valyakin/aa-testkit`
// `mocha` standard functions and `expect` from `chai` are available globally
// `Testkit`, `Network`, `Nodes` and `Utils` from `aa-testkit` are available globally too
const { expect } = require('chai');
const path = require('path')

describe('Check prediction AA', function () {
	this.timeout(120000)

	before(async () => {
		this.network = await Network.create()
			.with.agent({ predictionBaseAgent: path.join(__dirname, "../agent.oscript") })
			.with.agent({ predictionFactoryAgent: path.join(__dirname, "../factory.oscript") })
			.with.agent({ forwarderAgent: path.join(__dirname, "../define-asset-forwarder.oscript") })
			.with.asset({ reserveAsset: {}})
			.with.wallet({ alice: { base: 10e9, reserveAsset: 10e9 } })
			.with.wallet({ bob: { base: 10e9, reserveAsset: 10e9 } })
			.with.wallet({ oracleOperator: 10e9 })
			.run();

		this.reserve_asset = this.network.asset.reserveAsset;
		this.alice = this.network.wallet.alice;
		this.aliceAddress = await this.alice.getAddress();

		this.bob = this.network.wallet.bob;
		this.bobAddress = await this.bob.getAddress();

		this.oracleOperator = this.network.wallet.oracleOperator;
		this.oracleOperatorAddress = await this.oracleOperator.getAddress();

		this.trading_period_length = 30 * 24 * 3600;
		this.waiting_period_length = 2 * 24 * 3600;

		this.feed_name = "FEED_NAME";
		this.datafeed_value = 'YES';
		this.issue_fee = 0.01;
		this.redeem_fee = 0.02;
		this.datafeed_draw_value = "unknown"

	});

	it('Create prediction', async () => {
		const { unit, error } = await this.network.wallet.alice.triggerAaWithData({
			toAddress: this.network.agent.predictionFactoryAgent,
			amount: 20000,
			data: {
				event: "New year",
				oracle: this.oracleOperatorAddress,
				comparison: "==",
				feed_name: this.feed_name,
				allow_draw: true,
				datafeed_value: this.datafeed_value,
				trading_period_length: this.trading_period_length,
				waiting_period_length: this.waiting_period_length,
				reserve_asset: this.reserve_asset,
				datafeed_draw_value: this.datafeed_draw_value
			}
		});

		expect(error).to.be.null;
		expect(unit).to.be.validUnit;

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit);

		expect(response.bounced).to.be.false;

		expect(response.response.responseVars.prediction_address).to.exist;

		this.prediction_address = response.response.responseVars.prediction_address;

		const { vars: vars1 } = await this.bob.readAAStateVars(this.prediction_address);
		const { vars: vars2 } = await this.bob.readAAStateVars(this.network.agent.predictionFactoryAgent);

		expect(vars1.yes_asset).to.exist;
		expect(vars1.no_asset).to.exist;
		expect(vars1.draw_asset).to.exist;

		const params = vars2[`prediction_${this.prediction_address}`];

		expect(params.yes_asset).to.exist;
		expect(params.no_asset).to.exist;
		expect(params.draw_asset).to.exist;

		expect(params.yes_asset).to.be.equal(vars1.yes_asset);
		expect(params.no_asset).to.be.equal(vars1.no_asset);
		expect(params.draw_asset).to.be.equal(vars1.draw_asset);

		this.yes_asset = vars1.yes_asset;
		this.no_asset = vars1.no_asset;
		this.draw_asset = vars1.draw_asset;
	});

	it('Alice issue tokens', async () => {
		const yes_amount = 0.5 * 1e9;
		const no_amount = 0.5 * 1e9;
		const draw_amount = 0.5 * 1e9;

		const amount = 1e9;

		const oldReserveBalance = 0;

		const { unit, error } = await this.alice.sendMulti({
			asset: this.reserve_asset,
			base_outputs: [{ address: this.prediction_address, amount: 1e4 }],
			asset_outputs: [{ address: this.prediction_address, amount }],
			messages: [{
				app: 'data',
				payload: {
					yes_amount,
					no_amount,
					draw_amount
				}
			}]
		})

		const target_reserve = Math.ceil(Math.sqrt(yes_amount ** 2 + no_amount ** 2 + draw_amount ** 2));
		const delta_reserve = oldReserveBalance - target_reserve;

		let needed_reserve = Math.abs(delta_reserve);
		needed_reserve = needed_reserve + Math.ceil(needed_reserve * this.issue_fee);

		expect(error).to.be.null;
		expect(unit).to.be.validUnit;

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit);

		await this.network.witnessUntilStable(response.response_unit);
		
		this.reserve = response.balances[this.reserve_asset];

		expect(response.bounced).to.be.false;

		const { vars: vars1 } = await this.bob.readAAStateVars(this.prediction_address);
		expect(vars1.supply_yes).to.be.equal(yes_amount);
		expect(vars1.supply_no).to.be.equal(no_amount);
		expect(vars1.supply_draw).to.be.equal(draw_amount);


		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })

		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.aliceAddress,
				asset: this.yes_asset,
				amount: yes_amount,
			},
			{
				address: this.aliceAddress,
				asset: this.no_asset,
				amount: no_amount,
			},
			{
				address: this.aliceAddress,
				asset: this.draw_asset,
				amount: draw_amount,
			},
			{
				address: this.aliceAddress,
				asset: this.reserve_asset,
				amount: amount - needed_reserve
			},
		]);

		this.alice_yes_amount = yes_amount;
		this.alice_no_amount = no_amount;
		this.alice_draw_amount = draw_amount;

		this.supply_yes = yes_amount;
		this.supply_no = no_amount;
		this.supply_draw = draw_amount;

	});

	it('Alice issue tokens (not enough reserve)', async () => {
		const yes_amount = 0.0051e9;
		const no_amount = 0.0251e9;
		const draw_amount = 0.0051e9;

		const amount = 10001;

		const { unit, error } = await this.alice.sendMulti({
			asset: this.reserve_asset,
			base_outputs: [{ address: this.prediction_address, amount: 1e4 }],
			asset_outputs: [{ address: this.prediction_address, amount }],
			messages: [{
				app: 'data',
				payload: {
					yes_amount,
					no_amount,
					draw_amount
				}
			}]
		})

		
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		await this.network.witnessUntilStable(unit);

		const new_reserve = Math.ceil(Math.sqrt((this.supply_yes + yes_amount) ** 2 + (this.supply_no + no_amount) ** 2 + (this.supply_draw + draw_amount) ** 2));
		let reserve_needed = Math.abs(this.reserve - new_reserve);
		const fee = Math.ceil(reserve_needed * this.issue_fee);
		reserve_needed = reserve_needed + fee;

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit);

		expect(response.bounced).to.be.true;
		expect(response.response.error).to.equal(`expected reserve amount: ${Math.abs(reserve_needed)}`)
		this.reserve = response.balances[this.reserve_asset];
	});

	it('Alice redeem yes tokens', async () => {
		const yes_amount = 0.3 * 1e9;

		this.alice_yes_amount = this.alice_yes_amount - yes_amount;
		this.supply_yes = this.supply_yes - yes_amount;

		const { unit, error } = await this.alice.sendMulti({
			asset: this.yes_asset,
			base_outputs: [{ address: this.prediction_address, amount: 1e4 }],
			asset_outputs: [{ address: this.prediction_address, amount: yes_amount }],
		});

		expect(error).to.be.null
		expect(unit).to.be.validUnit
	
		await this.network.witnessUntilStable(unit);

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit);

		const { vars: vars1 } = await this.bob.readAAStateVars(this.prediction_address);

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit });

		const new_reserve = Math.ceil(Math.sqrt(this.supply_yes ** 2 + this.supply_no ** 2 + this.supply_draw ** 2));

		const payout = Math.abs(this.reserve - new_reserve);
		const fee = Math.ceil(payout * this.redeem_fee);

		expect(vars1.supply_yes).to.be.equal(this.supply_yes);
		expect(vars1.supply_no).to.be.equal(this.supply_no);
		expect(vars1.supply_draw).to.be.equal(this.supply_draw);

		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.aliceAddress,
				asset: this.reserve_asset,
				amount: payout - fee
			},
		]);

		this.reserve = response.balances[this.reserve_asset];
	});

	it('Bob issue tokens', async () => {
		const yes_amount = 2432250;
		const no_amount = 142350;
		const draw_amount = 5421500;

		const amount = 150000000;

		const { unit, error } = await this.bob.sendMulti({
			asset: this.reserve_asset,
			base_outputs: [{ address: this.prediction_address, amount: 1e4 }],
			asset_outputs: [{ address: this.prediction_address, amount }],
			messages: [{
				app: 'data',
				payload: {
					yes_amount,
					no_amount,
					draw_amount
				}
			}]
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		this.supply_yes += yes_amount;
		this.supply_no += no_amount;
		this.supply_draw += draw_amount;

		const target_reserve = Math.ceil(Math.sqrt(this.supply_yes ** 2 + this.supply_no ** 2 + this.supply_draw ** 2));
		const delta_reserve = this.reserve - target_reserve;

		let needed_reserve = Math.abs(delta_reserve);
		needed_reserve = needed_reserve + Math.ceil(needed_reserve * this.issue_fee);
	

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit);
		await this.network.witnessUntilStable(response.response_unit);

		const { vars: vars1 } = await this.bob.readAAStateVars(this.prediction_address);

		expect(vars1.supply_yes).to.be.equal(this.supply_yes);
		expect(vars1.supply_no).to.be.equal(this.supply_no);
		expect(vars1.supply_draw).to.be.equal(this.supply_draw);


		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })

		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.bobAddress,
				asset: this.yes_asset,
				amount: yes_amount,
			},
			{
				address: this.bobAddress,
				asset: this.no_asset,
				amount: no_amount,
			},
			{
				address: this.bobAddress,
				asset: this.draw_asset,
				amount: draw_amount,
			},
			{
				address: this.bobAddress,
				asset: this.reserve_asset,
				amount: amount - needed_reserve,
			},
		]);

		this.bob_yes_amount = yes_amount;
		this.bob_no_amount = no_amount;
		this.bob_draw_amount = draw_amount;
	});

	it('Bob issues tokens after the period expires', async () => {
		const { error } = await this.network.timetravel({ shift: this.trading_period_length * 1000 + 100 });
		expect(error).to.be.null;

		const yes_amount = 250;
		const no_amount = 250;
		const draw_amount = 150;

		const amount = 1e9;

		const { unit, error: error2 } = await this.bob.sendMulti({
			asset: this.reserve_asset,
			base_outputs: [{ address: this.prediction_address, amount: 1e4 }],
			asset_outputs: [{ address: this.prediction_address, amount }],
			messages: [{
				app: 'data',
				payload: {
					yes_amount,
					no_amount,
					draw_amount
				}
			}]
		})

		expect(error2).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit);

		expect(response.bounced).to.be.true;
		expect(response.response.error).to.equal("the trading period is already closed");
	});

	it('Bob commit result in wait period (without data_value)', async () => {
		const { unit, error } = await this.network.wallet.bob.triggerAaWithData({
			toAddress: this.prediction_address,
			amount: 1e4,
			data: {
				commit: 1
			}
		});

		expect(error).to.be.null;
		expect(unit).to.be.validUnit;

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit);

		expect(response.response.error).to.be.equal("waiting period has not ended yet");
	});



	it('Operator posts data feed', async () => {
		const { unit, error } = await this.oracleOperator.sendMulti({
			messages: [{
				app: 'data_feed',
				payload: {
					[this.feed_name]: this.datafeed_draw_value
				}
			}]
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { unitObj } = await this.oracleOperator.getUnitInfo({ unit: unit })
		const dfMessage = unitObj.messages.find(m => m.app === 'data_feed')
		expect(dfMessage.payload[this.feed_name]).to.be.equal(this.datafeed_draw_value)
		await this.network.witnessUntilStable(unit);

		const { error: error2 } = await this.network.timetravel({ shift: this.waiting_period_length * 1000 + 100 });
		expect(error2).to.be.null;
	})

	it('Bob commit result', async () => {
		const { unit, error } = await this.network.wallet.bob.triggerAaWithData({
			toAddress: this.prediction_address,
			amount: 1e4,
			data: {
				commit: 1
			}
		});

		expect(error).to.be.null;
		expect(unit).to.be.validUnit;

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit);
		expect(response.bounced).to.be.false;
		expect(response.response.responseVars.messages).to.be.equal('The result is committed');

		const { vars } = await this.bob.readAAStateVars(this.prediction_address);
		expect(vars.result).to.be.equal('draw');
		this.reserve = response.balances[this.reserve_asset];
	});

	it('Alice claim profit', async () => {
		const { unit, error } = await this.alice.sendMulti({
			asset: this.draw_asset,
			base_outputs: [{ address: this.prediction_address, amount: 1e4 }],
			asset_outputs: [{ address: this.prediction_address, amount: this.alice_draw_amount }],
		});

		const price = (this.reserve / this.supply_draw);
		const expect_payout = Math.floor(price * this.alice_draw_amount);

		this.supply_draw -= this.alice_draw_amount;

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit);
		expect(response.response.responseVars['Your profit']).to.be.equal(expect_payout);
		expect(response.bounced).to.be.false;

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit });
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.aliceAddress,
				amount: expect_payout,
				asset: this.reserve_asset
			},
		]);

		expect(error).to.be.null;
		expect(unit).to.be.validUnit;

		const { vars } = await this.bob.readAAStateVars(this.prediction_address);
		expect(vars.supply_yes).to.be.equal(this.supply_yes);
	});

	it('Alice send lose token', async () => {
		const { unit } = await this.alice.sendMulti({
			asset: this.no_asset,
			base_outputs: [{ address: this.prediction_address, amount: 1e4 }],
			asset_outputs: [{ address: this.prediction_address, amount: this.alice_no_amount }],
		});

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit);
		expect(response.bounced).to.be.true;
		expect(response.response.error).to.be.equal("you are sending not a winner token")
	});

	after(async () => {
		await this.network.stop()
	})
})
