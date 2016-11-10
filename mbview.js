/* eslint-disable no-console */

var express = require('express');
var app = express();
var MBTiles = require('mbtiles');
var q = require('d3-queue').queue();
var utils = require('./utils');
var objectAssign = require('object-assign');

var zlib = require('./node-zlib');
var pbf = require('pbf');
var fs = require('fs');
var VectorTile = require('vector-tile').VectorTile;
var vtpbf = require('vt-pbf');

var sm = new (require('sphericalmercator'));

var bodyParser = require('body-parser');

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.set('views', __dirname + '/views');

app.set('view engine', 'ejs');
app.use(express.static('public'));

cors = require('cors');
app.use(cors());


module.exports = {

    /**
     * Load a tileset and return a reference with metadata
     * @param {object} file reference to the tileset
     * @param {function} callback that returns the resulting tileset object
     */
    loadTiles: function (file, callback) {
        new MBTiles(file, function (err, tiles) {
            if (err) throw err;
            tiles.getInfo(function (err, info) {
                if (err) throw err;

                var tileset = objectAssign({}, info, {
                    tiles: tiles
                });

                callback(null, tileset);
            });
        });
    },

    /**
    * Defer loading of multiple MBTiles and spin up server.
    * Will merge all the configurations found in the sources.
    * @param {object} config for the server, e.g. port
    * @param {function} callback with the server configuration loaded
    */
    serve: function (config, callback) {
        var loadTiles = this.loadTiles;
        var listen = this.listen;

        config.mbtiles.forEach(function (file) {
            q.defer(loadTiles, file);
        });

        q.awaitAll(function (error, tilesets) {
            if (error) throw error;
            // if (!config.quiet) {
            //   console.log('*** Config', config);
            //   console.log('*** Metadata found in the MBTiles');
            //   console.log(tilesets);
            // }

            var finalConfig = utils.mergeConfigurations(config, tilesets);
            listen(finalConfig, callback);
        });
    },

    listen: function (config, onListen) {
        app.get('/', function (req, res) {
            res.render('map', config);
        });

        app.get('/:source/:z/:x/:y.pbf', function (req, res) {
            var p = req.params;

            var tiles = config.sources[p.source].tiles;
            tiles.getTile(p.z, p.x, p.y, function (err, tile, headers) {
                if (err) {
                    res.end();
                } else {
                    res.writeHead(200, headers);
                    res.end(tile);
                }
            });
        });

        // v0.0.1 动态修改切片的接口
        app.post('/:source/:vector_layers/:bounds/:z/:x/:y.pbf', function (req, res) {
            var startTime = new Date().getTime();
            var p = req.params;
            var q = req.query;
            var r = req.body;

            var tiles = config.sources[p.source].tiles;

            // 查询的唯一键，id，根据这个字段去查询
            var queryKey = Object.keys(q);

            // 这个是所有需要修改的所有键的数组，所有前台传过来的需要修改的字段和值
            var editKeys = Object.keys(r);

            // 查询所有等级的zxy
            queryRefTilesPosition(p.z, p.x, p.y, 5, 8, p.bounds, function (err, result) {
                err && console.log(err);
                var num = result.length - 1;

                console.dir(result.length);
                console.dir(result);

                // return;
                if (result.length) {
                    changeProperties(num, result, tiles, p, q, r, queryKey, editKeys, res);

                    // for (var i = 0; i < result.length; i++) {
                    //     console.log(result[i].z);
                    //     tiles.getTile(result[i].z, result[i].x, result[i].y, function (err, tile, headers) {
                    //         if (err) {
                    //             res.end();
                    //         } else {
                    //             //res.writeHead(200, headers);
                    //             zlib.gunzip(tile, function (err, buffer) {
                    //                 err && console.dir(err);

                    //                 var vectorTileContent = new VectorTile(new pbf(buffer)),
                    //                     values = vectorTileContent['layers'][p.vector_layers]['_values'],
                    //                     valueLength = values.length,
                    //                     keys = vectorTileContent['layers'][p.vector_layers]['_keys'],
                    //                     keysLength = keys.length,
                    //                     valuesIndex = keys.indexOf(queryKey[0]);

                    //                 // 循环遍历values里面的所有value
                    //                 // 这里是遍历了keys倍数的values
                    //                 for (; valuesIndex < valueLength; valuesIndex += keysLength) {
                    //                     if (values[valuesIndex] == q[queryKey[0]]) {
                    //                         editKeys.forEach(function (editKey) {
                    //                             // if (editKey != 'queryBounds') {
                    //                             values[valuesIndex + (keys.indexOf(queryKey[0]) - keys.indexOf(editKey))] = r[editKey];
                    //                             // }
                    //                         });
                    //                     }
                    //                 }

                    //                 zlib.gzip(vtpbf(vectorTileContent), function (err, ss) {
                    //                     tiles.changeTile(result[i].z, result[i].x, result[i].y, ss, function (err, result) {
                    //                         console.log('============================stop===================================');
                    //                         if (err) {
                    //                             console.log('err:', err);
                    //                             res.json({
                    //                                 "status": 0,
                    //                                 "message": "error"
                    //                             });
                    //                         } else {
                    //                             // console.dir(vectorTileContent.layers[p.vector_layers]._values);
                    //                             // console.log(((new Date()).getTime()) - startTime);
                    //                             res.json({
                    //                                 "status": 1,
                    //                                 "message": "success"
                    //                             });
                    //                         }
                    //                     });
                    //                 });
                    //             });
                    //         }
                    //     });
                    // }
                }
            });
        });



        // 根据一个瓦片的z，x，y的值，查询数据所在瓦片每个等级对应的瓦片的z，x，y的集合，array
        // callback 参数  1. err 成功或者失败,如果成功为null   2. 查询到的结果输出 array
        function queryRefTilesPosition(z, x, y, minZoom, maxZoom, bounds, callback) {
            var xyzs = [];  // 存储所有查询到的切片索引
            for (var i = 0; i < maxZoom - minZoom + 1; i++) {
                var xyz = sm.xyz(bounds.split(','), minZoom + i);
                xyz.zoom = minZoom + i;

                // 可能会出现一个地块在不同的瓦片上，所以需要判断循环一下
                for (var t = 0; t <= (xyz.maxX - xyz.minX); t++) {
                    // console.log('t:', t);
                    for (var j = 0; j <= (xyz.maxY - xyz.minY); j++) {
                        // console.log('j:', j);
                        xyzs.push({
                            x: xyz.minX + t,
                            y: xyz.minY + j,
                            z: xyz.zoom
                        });
                    }
                }
            }

            callback(null, xyzs);
        }


        // 需要递归调用的解压和压缩之后进行修改切片属性的函数
        function changeProperties(num, result, tiles, p, q, r, queryKey, editKeys, res) {
            tiles.getTile(result[num].z, result[num].x, result[num].y, function (err, tile, headers) {
                if (err) {
                    res.end();
                } else {
                    zlib.gunzip(tile, function (err, buffer) {
                        err && console.dir(err);

                        var vectorTileContent = new VectorTile(new pbf(buffer)),
                            values = vectorTileContent['layers'][p.vector_layers]['_values'],
                            valueLength = values.length,
                            keys = vectorTileContent['layers'][p.vector_layers]['_keys'],
                            keysLength = keys.length,
                            valuesIndex = keys.indexOf(queryKey[0]);

                        // 循环遍历values里面的所有value
                        // 这里是遍历了keys倍数的values
                        for (; valuesIndex < valueLength; valuesIndex += keysLength) {
                            if (values[valuesIndex] === +q[queryKey[0]]) {
                                editKeys.forEach(function (editKey) {
                                    values[valuesIndex + (keys.indexOf(editKey) - keys.indexOf(queryKey[0]))] = r[editKey];
                                });
                                break;
                            }
                        }

                        // console.log((new VectorTile(new pbf(vtpbf(vectorTileContent)))).layers[p.vector_layers]._values);

                        zlib.gzip(vtpbf(vectorTileContent), function (err, ss) {
                            tiles.changeTile(result[num].z, result[num].x, result[num].y, ss, function (err) {
                                if (num > 0) {
                                    changeProperties(--num, result, tiles, p, q, r, queryKey, editKeys, res);
                                } else {
                                    if (err) {
                                        console.log('err:', err);
                                        res.json({
                                            "status": 0,
                                            "message": "error"
                                        });
                                    } else {
                                        res.json({
                                            "status": 1,
                                            "message": "success"
                                        });
                                    }
                                }
                            });
                        });
                    });
                }
            });
        }



        config.server = app.listen(config.port, function () {
            onListen(null, config);
        });
    }

};
