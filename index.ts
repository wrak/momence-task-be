import express from 'express';
import dotenv from 'dotenv';
import fs from 'fs';
import http from 'http';
import moment from 'moment-timezone';
import {parse} from 'csv-parse'

dotenv.config();

const rootPath = process.cwd();
const ratesFilename = `${rootPath}/cnb-rates.txt`;
const ratesURL = 'http://www.cnb.cz/en/financial-markets/foreign-exchange-market/central-bank-exchange-rate-fixing/central-bank-exchange-rate-fixing/daily.txt';
// CNB documentation doesn't provide info on specific timezone, let's assume it's CET
const timezone = 'Europe/Prague'
const tresholdTime = {
    hour: 14,
    minute: 30,
    second: 0,
}

const app = express();
const port = process.env.PORT || 8081;

type CurrencyRecord = {
    country: string,
    code: string,
    rate: number,
};

app.use(function (_, res, next) {
    res.setHeader('access-control-allow-origin', '*');
    next();
});

app.get('/api/convert', async (req, res) => {
    try {
        const records = await getRates();

        const amountParam = req.query['amount'];
        if (amountParam == null || amountParam === '') {
            res.status(400).json({error: 'You must provide amount '});
            return;
        }

        const amount = Number(amountParam);
        if (Number.isNaN(amount)) {
            res.status(400).send({error: 'Provided amount is not a number'});
            return;
        }

        const codeParam = req.query['code'];
        if (codeParam == null || codeParam === '') {
            res.status(400).send({error: 'You must provide code'});
            return;
        }

        const record = records.find((item) => item.code === codeParam);
        if (!record) {
            res.status(400).send({error: 'Provided code is not valid'});
            return;
        }

        res.json({
            result: amount / record.rate,
        });
    } catch (e) {
        log(e);

        res.status(500).json({error: 'Unknown error has occurred'});
    }
});

app.get('/api/currencies', async (req, res) => {
    try {
        const records = await getRates();

        res.json(records);
    } catch (e) {
        log(e)

        res.status(500).json({error: 'Unknown error has occurred'});
    }
})

app.listen(port, () => {
    log(`Server is running at http://localhost:${port}`);
});

const log = (message: any) => {
    console.log(`${new Date().toISOString()}: ${message}`)
}

const getRates = async () => {
    if (shouldDownloadRatesFile()) {
        await downloadRatesFile();
        log('Rates file downloaded');
    }

    return await parseRatesFile();
}

const shouldDownloadRatesFile = () => {
    const fileStats = fs.statSync(ratesFilename, {
        throwIfNoEntry: false
    });

    // file does not exist
    if (fileStats == null) {
        return true;
    }

    // did the rates changed since the last download?
    // note: Following will return true even on weekends. It's unnecessary however it won't hurt anything.
    const now = moment.utc().tz(timezone);
    const treshold = moment(now)
        .hour(tresholdTime.hour)
        .minute(tresholdTime.minute)
        .second(tresholdTime.second);
    const fileModifiedTime = moment.utc(fileStats.mtime).tz(timezone);

    return now.isSameOrAfter(treshold) && fileModifiedTime.isBefore(treshold);
}

const deleteRatesFile = () => {
    if (!fs.existsSync(ratesFilename)) {
        return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
        fs.unlink(ratesFilename, (err) => {
            if (err) reject(err);
            else resolve();
        });
    })
}

const downloadRatesFile = () => {
    return new Promise<void>((resolve, reject) => {
        try {
            // first delete the rates file if it exists
            deleteRatesFile().catch(reject);

            // download the rates files
            const file = fs.createWriteStream(ratesFilename);
            http.get(ratesURL, (res) => {
                res.pipe(file);

                file.on('finish', () => {
                    file.close((err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
            }).on('error', (err) => {
                deleteRatesFile().catch(reject);
                reject(err);
            })
        } catch (e) {
            deleteRatesFile().catch(reject);
            reject(e);
        }
    });
}

const parseRatesFile = () => {
    return new Promise<Array<CurrencyRecord>>((resolve, reject) => {
        fs.readFile(ratesFilename, (err, data) => {
            if (err) {
                return reject(err);
            }

            // find start of the data; trim first line from the data since it contains metadata
            const dataStart = Array.from(data.entries()).findIndex((value) => {
                return value[1] == 10; // new line in ASCII table
            });

            parse(data.subarray(dataStart), {
                delimiter: '|',
                skip_empty_lines: true,
                from: 2,
            }, (err, records) => {
                if (err) {
                    return reject(err);
                }

                const formatted = (records as Array<Array<string>>).reduce((acc, row) => {
                        return [
                            ...acc,
                            {
                                country: row[0],
                                code: row[3],
                                rate: Number(row[4]),
                            }
                        ]
                    }
                    , [] as Array<CurrencyRecord>);

                resolve(formatted)
            })
        })
    })
}
