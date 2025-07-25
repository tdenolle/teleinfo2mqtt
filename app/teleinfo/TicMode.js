const SerialPort = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const { EventEmitter } = require('events');
const { emitInterval, serial } = require('../config');
const log = require('../log');

const CENTURY = '20';
const TIMESTAMP_REGEX = /^(?<dst>H|E|\s?)(?<year>\d{2})(?<month>\d{2})(?<day>\d{2})(?<hour>\d{2})(?<min>\d{2})(?<second>\d{2})$/;

/**
 * Abstract TicMode service class.
 */
class TicMode {
    /**
     * Build a new TicMode service.
     */
    constructor() {
        this.serialPort = undefined;
        this.previousFrame = {};
        this.currentFrame = {};
        this.currentFailed = false;
        this.eventEmitter = new EventEmitter();
        this.lastEmitTime = Date.now();
        this.lastFrameSent = {};
        this.stats = {
            ok: 0,
            dispatched: 0,
            failed: 0,
        };

        // Graceful exit
        process.on('SIGTERM', () => this.disconnect());
        process.on('SIGINT', () => this.disconnect());
    }

    /**
     * Which mode is it? history or standard?
     */
    /* eslint-disable no-unused-vars */
    static doesMatchMode(ticMode) {
        throw new Error('doesMatchMode must be overridden');
    }

    /**
     * Connect to the serial port.
     * @param SerialPortClass
     * @param BindingClass
     * @return {Promise<unknown>}
     */
    connect(SerialPortClass = SerialPort, BindingClass = undefined) {
        log.info(`Connecting to port [${serial}] with ${this.getMode()} TIC mode`);
        const options = {
            path: serial,
            baudRate: this.getBaudRate(),
            dataBits: 7,
            parity: 'even',
            stopBits: 1,
        };
        if (BindingClass) {
            options.binding = BindingClass;
        }
        return new Promise((resolve, reject) => {
            this.serialPort = new SerialPortClass(
                options,
                (error) => this.onConnection(error, resolve, reject),
            );
        });
    }

    /**
     * On serial port connection event.
     * @param connectionError
     * @param resolve
     * @param reject
     */
    onConnection(connectionError, resolve, reject) {
        if (connectionError) {
            log.error(`Error when connecting to serial port [${connectionError.message}]`);
            reject(connectionError);
        } else {
            log.info(`Connected to port [${serial}]`);
            const parser = this.serialPort.pipe(new ReadlineParser());

            // Process data and errors
            parser.on('data', (data) => this.processData(data));
            parser.on('error', (error) => this.processError(error));
            resolve(this);
        }
    }

    /**
     * Process serial data.
     * @param data
     */
    processData(data) {
        log.debug(`Raw frame (${data.length}) [${data}]`);
        const dataStr = data.toString('utf-8').replace(/\r$/, '');
        log.debug(`Trim frame (${dataStr.length}) [${dataStr}]`);

        // escape ETXSTX line
        if (dataStr.match(/(\u0002|\u0003)$/)) {
            return;
        }

        // Split line `${label} ${timestamp?} ${value} ${checksum}
        const lineItems = dataStr.split(this.getDataDelimiter());
        log.debug(`Split frame [${lineItems.toString()}]`);

        if (lineItems.length < 3 || lineItems.length > 4) {
            log.warn(`Corrupted line received [${dataStr}]`);
            this.currentFailed = true;
            return;
        }

        const label = lineItems[0];
        const value = this.getValue({ label, lineItems });
        const checksum = lineItems.slice(-1);

        // Is checksum valid ?
        const checksumData = dataStr.substring(0, dataStr.length - checksum.length);
        const checksumDataLength = checksumData.length;
        log.debug(`Checksum Data String [${checksumData}] (${checksumDataLength})`);
        const calculatedChecksum = this.calculateChecksum(checksumData);
        if (calculatedChecksum !== checksum.toString()) {
            log.warn(`Invalid checksum for label ${label} [${checksumData}] [${checksum}]. Should be [${calculatedChecksum}]`);
            this.currentFailed = true;
            return;
        }

        // Is the value valid?
        const previousValue = this.previousFrame[label]
            ? this.previousFrame[label].value : undefined;
        if (!this.checkValue({ label, previousValue, value })) {
            log.warn(`Invalid value received for label ${label} [${value}]`);
            this.currentFailed = true;
            return;
        }
        log.debug(`Value for label ${label} = ${value}`);

        // Does the line contain a timestamp?
        const timestampStr = this.getTimestamp({ label, lineItems });

        // Compute a clean frame item
        let frameItem;
        try {
            frameItem = this.parseFrameItem({ label, value, timestampStr });
            log.debug(`Frame parsed [${frameItem}]`);
        } catch (e) {
            log.warn(`Error on parsing the value [${value}] and the timestamp [${timestampStr}] for label [${label}]: [${e.message}]`);
            this.currentFailed = true;
            return;
        }

        // Frame end? -> Dispatch frame event
        if (this.isFrameEnd(label)) {
            const frameSize = Object.keys(this.currentFrame).length - 1;
            log.debug(`Frame size : ${frameSize} - ${this.currentFailed}`);
            if (!this.currentFailed) {
                // Don't emit a second frame in emit interval
                const currentTime = Date.now();
                log.debug(`Current time : ${currentTime} - Last emit time : ${this.lastEmitTime}`);
                if (currentTime - this.lastEmitTime > emitInterval * 1000) {
                    log.debug(`Dispatch frame ${JSON.stringify(this.currentFrame)}`);
                    this.eventEmitter.emit('frame', this.currentFrame);
                    this.lastEmitTime = currentTime;
                    this.lastFrameSent = this.currentFrame;
                    this.stats.dispatched += 1;
                } else {
                    log.debug(`Ignoring MQTT emission because of emit interval (Emit interval : ${emitInterval} - Last emit time : ${this.lastEmitTime} - Current time : ${currentTime}`);
                }
                this.stats.ok += 1;
            } else {
                log.debug('Ignoring MQTT emission because of frame failed');
                this.stats.failed += 1;
            }
            if (!this.isFrameStart(label)) {
                this.currentFailed = true;
                return;
            }
        }

        // Frame start? -> Reset frame object
        if (this.isFrameStart(label)) {
            this.previousFrame = this.currentFrame;
            this.currentFrame = {};
            this.currentFailed = false;
        }

        // Add the new item to the current frame
        this.currentFrame[label] = frameItem;
    }

    /**
     * Process serial errors.
     * @param error
     */
    /* eslint-disable class-methods-use-this */
    processError(error) {
        log.error('Error on reading data');
        log.error(error);
    }

    /**
     * Disconnect from serial port.
     */
    disconnect() {
        if (this.serialPort) {
            log.info(`Disconnecting teleinfo from port [${serial}]`);
            this.serialPort.close((e) => {
                if (e) {
                    log.error(`Error on disconnecting teleinfo from port [${serial}]`);
                } else {
                    log.info(`Disconnected teleinfo from port [${serial}]`);
                }
            });
        }
    }

    /**
     * Sanitize value & try to convert to number.
     * @param label
     * @param value
     */
    getValueCoerced({ label, value }) {
        const valueSanitized = value.replace(/\.\./g, '');
        const valueNumber = Number.parseInt(valueSanitized, 10);
        return !Number.isNaN(valueNumber) ? valueNumber : valueSanitized;
    }

    /**
     * Check data integrity.
     */
    /* eslint-disable class-methods-use-this */
    /* eslint-disable no-unused-vars */
    parseFrameItem({ label, value, timestampStr }) {
        let timestamp;
        if (timestampStr) {
            const timestampMatched = timestampStr.match(TIMESTAMP_REGEX);
            if (!timestampMatched) {
                throw new Error(`Invalid timestamp (${timestampStr}`);
            }
            timestamp = {
                dst: timestampMatched.groups.dst === 'H' ? 'winter' : 'summer',
                date: new Date(Date.UTC(
                    `${CENTURY}${timestampMatched.groups.year}`,
                    Number.parseInt(timestampMatched.groups.month - 1, 10),
                    timestampMatched.groups.day,
                    timestampMatched.groups.hour,
                    timestampMatched.groups.min,
                    timestampMatched.groups.second,
                )).toISOString(),
            };
        }

        return {
            raw: value,
            value: this.getValueCoerced({ label, value }),
            timestamp,
        };
    }

    /**
     * Register on-frame handler.
     * @param handler
     */
    onFrame(handler) {
        this.eventEmitter.on('frame', (frame) => handler(frame));
    }

    /**
     * Get value associated to the label.
     * @param label
     * @param lineItems
     * @return {*}
     */
    getValue({ label, lineItems }) {
        return lineItems[1];
    }

    /**
     * Get timestamp associated to the label.
     * @param label
     * @param lineItems
     * @return {undefined}
     */
    getTimestamp({ label, lineItems }) {
        return undefined;
    }

    /**
     * Get TIC mode.
     */
    /* eslint-disable class-methods-use-this */
    getMode() {
        throw new Error('getMode must be overridden');
    }

    /**
     * Get the list of labels managed by this TicMode
     */
    /* eslint-disable class-methods-use-this */
    getLabels() {
        throw new Error('getMode must be overridden');
    }

    /**
     * Get baud rate.
     */
    /* eslint-disable class-methods-use-this */
    getBaudRate() {
        throw new Error('getBaudRate must be overridden');
    }

    /**
     * Check data value
     */
    /* eslint-disable class-methods-use-this */
    /* eslint-disable no-unused-vars */
    checkValue({ label, previousValue, value }) {
        throw new Error('checkValue must be overridden');
    }

    /**
     * Get stats
     * @returns {Object}
     * */
    getStats() {
        return this.stats;
    }

    /**
     * Is it the end of the frame?
     * @param label
     */
    /* eslint-disable class-methods-use-this */
    /* eslint-disable no-unused-vars */
    isFrameStart(label) {
        throw new Error('isFrameStart must be overridden');
    }

    /**
     * Is it the end of the frame?
     */
    /* eslint-disable class-methods-use-this */
    /* eslint-disable no-unused-vars */
    isFrameEnd(label) {
        throw new Error('isFrameEnd must be overridden');
    }

    /**
     * Get the id label of the frame (ADCO, ADSC...).
     */
    getIdLabel() {
        throw new Error('getIdLabel must be overridden');
    }

    /**
     * Get the HA device Class.
     * @param label
     */
    getHADeviceClass(label) {
        throw new Error('getHADeviceClass must be overridden');
    }

    /**
     * Get the HA state Class.
     * @param label
     */
    getHAStateClass(label) {
        throw new Error('getHAStateClass must be overridden');
    }

    /**
     * Get the HA unit.
     * @param label
     */
    getHAUnit(label) {
        throw new Error('getHAUnit must be overridden');
    }

    /**
     * Get frame data delimiter (space, tab...)
     * @returns {RegExp}
     */
    getDataDelimiter() {
        return /\s+/;
    }

    /**
     * Calculate checksum based on input string
     * @param {string} strData
     * @returns {string}
     */
    calculateChecksum(strData) {
        let checksum = 0;
        for (let i = 0; i < strData.length; i += 1) { checksum += strData.charCodeAt(i); }
        // eslint-disable-next-line no-bitwise
        checksum = (checksum & 63) + 32;
        return String.fromCharCode(checksum);
    }
}

module.exports = TicMode;
