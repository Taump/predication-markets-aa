// uses `aa-testkit` testing framework for AA tests. Docs can be found here `https://github.com/valyakin/aa-testkit`
// `mocha` standard functions and `expect` from `chai` are available globally
// `Testkit`, `Network`, `Nodes` and `Utils` from `aa-testkit` are available globally too
const { expect } = require('chai');
const path = require('path')

describe('Check predication AA', function () {
	this.timeout(120000)

	before(async () => {
		this.network = await Network.create()
			.with.agent({ predicationBaseAgent: path.join(__dirname, "../agent.oscript") })
			.with.agent({ predicationFactoryAgent: path.join(__dirname, "../factory.oscript") })
			.with.agent({ forwarderAgent: path.join(__dirname, "../define-asset-forwarder.oscript") })
			.with.wallet({ alice: 10e9 })
			.with.wallet({ bob: 10e9 })
			.with.wallet({ oracleOperator: 10e9 })
			.run();

		this.alice = this.network.wallet.alice;
		this.aliceAddress = await this.alice.getAddress();

		this.bob = this.network.wallet.bob;
		this.bobAddress = await this.bob.getAddress();

		this.oracleOperator = this.network.wallet.oracleOperator;
		this.oracleOperatorAddress = await this.oracleOperator.getAddress();

		this.trading_period_length = 30 * 24 * 3600;
		this.waiting_period_length = 2 * 24 * 3600;

		this.feed_name = "FEED_NAME";
		this.datafeed_value = 'true';

	});

	it('Create predication', async () => {
		const { unit, error } = await this.network.wallet.alice.triggerAaWithData({
			toAddress: this.network.agent.predicationFactoryAgent,
			amount: 20000,
			data: {
				event: "New yeardfs",
				oracle: this.oracleOperatorAddress,
				comparison: "==",
				feed_name: this.feed_name,
				allow_draw: true,
				datafeed_value: this.datafeed_value,
				trading_period_length: this.trading_period_length,
				waiting_period_length: this.waiting_period_length
			}
		});

		expect(error).to.be.null;
		expect(unit).to.be.validUnit;

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit);

		expect(response.bounced).to.be.false;

		expect(response.response.responseVars.predication_address).to.exist;

		this.predication_address = response.response.responseVars.predication_address;

		const { vars: vars1 } = await this.bob.readAAStateVars(this.predication_address);
		const { vars: vars2 } = await this.bob.readAAStateVars(this.network.agent.predicationFactoryAgent);

		expect(vars1.yes_asset).to.exist;
		expect(vars1.no_asset).to.exist;
		expect(vars1.draw_asset).to.exist;

		const params = vars2[`predication_${this.predication_address}`];

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
		const yes_amount = 250;
		const no_amount = 250;
		const draw_amount = 150;

		const amount = 150000;

		const { unit, error } = await this.network.wallet.alice.triggerAaWithData({
			toAddress: this.predication_address,
			amount,
			data: {
				yes_amount,
				no_amount,
				draw_amount
			}
		})

		const reserve = Math.ceil(Math.sqrt(yes_amount ** 2 + no_amount ** 2 + draw_amount ** 2));
		this.reserve = reserve;

		expect(error).to.be.null;
		expect(unit).to.be.validUnit;

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit);

		expect(response.bounced).to.be.false;

		const { vars: vars1 } = await this.bob.readAAStateVars(this.predication_address);

		expect(vars1.reserve).to.be.equal(reserve);
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
				amount: amount - reserve - 10000,
			},
		]);

		this.alice_yes_amount = yes_amount;
		this.alice_no_amount = no_amount;
		this.alice_draw_amount = draw_amount;

		this.supply_yes = yes_amount;
		this.supply_no = no_amount;
		this.supply_draw = draw_amount;

		await this.network.witnessUntilStable(response.response_unit)

	});

	it('Alice issue tokens (not enough reserve)', async () => {
		const yes_amount = 250;
		const no_amount = 250;
		const draw_amount = 150;

		const amount = 10001;

		const { unit, error } = await this.network.wallet.alice.triggerAaWithData({
			toAddress: this.predication_address,
			amount,
			data: {
				yes_amount,
				no_amount,
				draw_amount
			}
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const new_reserve = Math.ceil(Math.sqrt((this.supply_yes + yes_amount) ** 2 + (this.supply_no + no_amount) ** 2 + (this.supply_draw + draw_amount) ** 2));

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit);

		expect(response.bounced).to.be.true;
		expect(response.response.error).to.equal(`expected reserve amount: ${Math.abs(new_reserve - this.reserve)}`)
	});

	it('Alice redeem yes tokens', async () => {
		const yes_amount = 50;

		this.alice_yes_amount = this.alice_yes_amount - yes_amount;

		const { unit, error } = await this.alice.sendMulti({
			asset: this.yes_asset,
			base_outputs: [{ address: this.predication_address, amount: 1e4 }],
			asset_outputs: [{ address: this.predication_address, amount: yes_amount }],
		});

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		this.supply_yes = this.supply_yes - yes_amount;

		await this.network.witnessUntilStable(unit);

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit);

		const { vars: vars1 } = await this.bob.readAAStateVars(this.predication_address);

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit });

		const new_reserve = Math.ceil(Math.sqrt(this.supply_yes ** 2 + this.supply_no ** 2 + this.supply_draw ** 2));

		const payout = this.reserve - new_reserve;

		this.reserve = new_reserve;

		expect(vars1.reserve).to.be.equal(this.reserve);
		expect(vars1.supply_yes).to.be.equal(this.supply_yes);
		expect(vars1.supply_no).to.be.equal(this.supply_no);
		expect(vars1.supply_draw).to.be.equal(this.supply_draw);

		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.aliceAddress,
				amount: payout
			},
		]);
	});

	it('Bob issue tokens', async () => {
		const yes_amount = 2250;
		const no_amount = 12350;
		const draw_amount = 21500;

		const amount = 1500000;

		const { unit, error } = await this.network.wallet.bob.triggerAaWithData({
			toAddress: this.predication_address,
			amount,
			data: {
				yes_amount,
				no_amount,
				draw_amount
			}
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const reserve = Math.ceil(Math.sqrt((this.supply_yes + yes_amount) ** 2 + (this.supply_no + no_amount) ** 2 + (this.supply_draw + draw_amount) ** 2));

		const needed_reserve = reserve - this.reserve;

		this.reserve = reserve;

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit);

		const { vars: vars1 } = await this.bob.readAAStateVars(this.predication_address);

		this.supply_yes += yes_amount;
		this.supply_no += no_amount;
		this.supply_draw += draw_amount;

		expect(vars1.reserve).to.be.equal(this.reserve);
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
				amount: amount - needed_reserve - 10000,
			},
		]);

		this.bob_yes_amount = yes_amount;
		this.bob_no_amount = no_amount;
		this.bob_draw_amount = draw_amount;

		await this.network.witnessUntilStable(response.response_unit)

	});

	it('Bob issues tokens after the period expires', async () => {
		const { error } = await this.network.timetravel({ shift: this.trading_period_length * 1000 + 100 });
		expect(error).to.be.null;

		const yes_amount = 250;
		const no_amount = 250;
		const draw_amount = 150;

		const amount = 1e9;

		const { unit, error: error2 } = await this.network.wallet.bob.triggerAaWithData({
			toAddress: this.predication_address,
			amount,
			data: {
				yes_amount,
				no_amount,
				draw_amount
			}
		})

		expect(error2).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit);

		expect(response.bounced).to.be.true;
		expect(response.response.error).to.equal("the trading period is already closed");
	});

	it('Bob commit result in wait period (without data_value)', async () => {
		const { unit, error } = await this.network.wallet.bob.triggerAaWithData({
			toAddress: this.predication_address,
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
					[this.feed_name]: this.datafeed_value
				}
			}]
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { unitObj } = await this.oracleOperator.getUnitInfo({ unit: unit })
		const dfMessage = unitObj.messages.find(m => m.app === 'data_feed')
		expect(dfMessage.payload[this.feed_name]).to.be.equal(this.datafeed_value)
		await this.network.witnessUntilStable(unit);

		const { error: error2 } = await this.network.timetravel({ shift: this.waiting_period_length * 1000 + 100 });
		expect(error2).to.be.null;
	})

	it('Bob commit result', async () => {
		const { unit, error } = await this.network.wallet.bob.triggerAaWithData({
			toAddress: this.predication_address,
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

		const { vars } = await this.bob.readAAStateVars(this.predication_address);
		expect(vars.result).to.be.equal('yes');
	});

	it('Alice claim profit', async () => {

		const { unit, error } = await this.alice.sendMulti({
			asset: this.yes_asset,
			base_outputs: [{ address: this.predication_address, amount: 1e4 }],
			asset_outputs: [{ address: this.predication_address, amount: this.alice_yes_amount }],
		});

		const expect_payout = Math.floor((this.reserve / this.supply_yes) * this.alice_yes_amount);

		this.supply_yes -= this.alice_yes_amount;
		this.reserve -= expect_payout;

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit);
		expect(response.response.responseVars['Your profit']).to.be.equal(expect_payout);
		expect(response.bounced).to.be.false;

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit });
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.aliceAddress,
				amount: expect_payout,
			},
		]);

		expect(error).to.be.null;
		expect(unit).to.be.validUnit;

		const { vars } = await this.bob.readAAStateVars(this.predication_address);
		expect(vars.supply_yes).to.be.equal(this.supply_yes);
		expect(vars.reserve).to.be.equal(this.reserve);
	});

	after(async () => {
		await this.network.stop()
	})
})
