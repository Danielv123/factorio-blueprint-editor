import FD from 'factorio-data'
import EventEmitter from 'eventemitter3'
import * as PIXI from 'pixi.js'
import io from 'socket.io-client'
import G from '../common/globals'
import util from '../common/util'
import Entity from './entity'
import { PositionGrid } from './positionGrid'
import generators from './generators'
import * as History from './history'
import Tile from './tile'

class OurMap<K, V> extends Map<K, V> {
    constructor(values?: V[], mapFn?: (value: V) => K) {
        if (values) {
            super(values.map(e => [mapFn(e), e] as [K, V]))
        } else {
            super()
        }
    }

    isEmpty() {
        return this.size === 0
    }

    valuesArray() {
        return [...this.values()]
    }

    find(predicate: (value: V, key: K) => boolean): V {
        for (const [k, v] of this) {
            if (predicate(v, k)) {
                return v
            }
        }
        return undefined
    }

    filter(predicate: (value: V, key: K) => boolean): V[] {
        const result: V[] = []
        this.forEach((v, k) => {
            if (predicate(v, k)) {
                result.push(v)
            }
        })
        return result
    }
}

interface IEntityData extends Omit<BPS.IEntity, 'entity_number'> {
    entity_number?: number
}

/** Blueprint base class */
// eslint-disable-next-line import/exports-last
export default class Blueprint extends EventEmitter {
    name: string
    icons: string[]
    entityPositionGrid: PositionGrid
    entities: OurMap<number, Entity>
    tiles: OurMap<string, Tile>
    socket: SocketIOClient.Socket

    private m_nextEntityNumber = 1

    constructor(data?: BPS.IBlueprint) {
        super()

        this.name = 'Blueprint'
        this.icons = []
        this.entities = new OurMap()
        this.tiles = new OurMap()
        this.entityPositionGrid = new PositionGrid(this)

        // Connect to clusterio master
        this.socket = io.connect('localhost:8080')
        this.socket.on('hello', () => {
            this.socket.emit('registerMapEditor')
            setTimeout(window.startLoading, 50) // Start loading starting area data once we are connected
        })

        if (data) {
            this.name = data.label
            if (data.icons) {
                data.icons.forEach(icon => {
                    this.icons[icon.index - 1] = icon.signal.name
                })
            }

            const offset = {
                x: G.sizeBPContainer.width / 64,
                y: G.sizeBPContainer.height / 64
            }

            if (data.tiles) {
                this.tiles = new OurMap(
                    data.tiles.map(
                        tile =>
                            new Tile(tile.name, {
                                x: tile.position.x + offset.x + 0.5,
                                y: tile.position.y + offset.y + 0.5
                            })
                    ),
                    t => t.hash
                )
            }

            if (data.entities !== undefined) {
                this.m_nextEntityNumber += data.entities.length

                const firstEntity = data.entities.find(e => !FD.entities[e.name].flags.includes('placeable_off_grid'))
                const firstEntityTopLeft = {
                    x: firstEntity.position.x - FD.entities[firstEntity.name].size.width / 2,
                    y: firstEntity.position.y - FD.entities[firstEntity.name].size.height / 2
                }

                offset.x += firstEntityTopLeft.x % 1 === 0 ? 0 : 0.5
                offset.y += firstEntityTopLeft.y % 1 === 0 ? 0 : 0.5

                History.startTransaction()

                this.entities = new OurMap(
                    data.entities.map(e =>
                        this.createEntity({
                            ...e,
                            position: {
                                x: e.position.x + offset.x,
                                y: e.position.y + offset.y
                            }
                        })
                    ),
                    e => e.entityNumber
                )

                History.commitTransaction()
            }
        }

        // makes initial entities non undoable and resets the history if the user cleared the editor
        History.reset()

        this.socket.on('updateEntity', data => {
            data.entities.forEach((entity, i, arr) => {
                if (entity.name === 'deleted') {
                    this.removeEntity(
                        this.entities.get(posToId({ x: Number(entity.x) + 2000, y: Number(entity.y) + 2000 })),
                        false
                    )
                } else {
                    this.createEntity(
                        {
                            name: entity.name,
                            entity_number: posToId({ x: Number(entity.x) + 2000, y: Number(entity.y) + 2000 }),
                            position: { x: Number(entity.x) + 2000, y: Number(entity.y) + 2000 },
                            direction: entity.direction
                        },
                        false
                    )
                }
            })
        })

        window.fetchedChunks = []
        // get starting area
        // window.startLoading() is called in app.ts after everything has initialized and the editor is done loading
        window.startLoading = () => {
            // get data around the player
            setInterval(() => {
                const playerPositionInBP = {
                    x:
                        Math.abs(G.BPC.position.x + G.BPC.viewport.getMiddle().x) /
                        G.BPC.viewport.getCurrentScale() /
                        32,
                    y: Math.abs(G.BPC.position.y + G.BPC.viewport.getMiddle().y) / G.BPC.viewport.getCurrentScale() / 32
                }
                // console.log(G.BPC.viewport.getMiddle())
                // console.log(playerPositionInBP)
                // Get chunks in a 5x5 area around the player
                let factorioChunkPosition = {
                    x: Math.floor((playerPositionInBP.x - 2000) / 32),
                    y: Math.floor((playerPositionInBP.y - 2000) / 32)
                }
                // console.log(factorioChunkPosition)
                for (let xc = 0; xc < 10; xc++) {
                    for (let yc = 0; yc < 10; yc++) {
                        this.getChunk(xc + factorioChunkPosition.x, yc + factorioChunkPosition.y)
                    }
                }
                // Unload chunks outside of 10x10 area
                window.fetchedChunks.forEach(cachedChunk => {
                    if (
                        cachedChunk.entities.length &&
                        (cachedChunk.xc < -2 + factorioChunkPosition.x ||
                            cachedChunk.xc > 12 + factorioChunkPosition.x ||
                            cachedChunk.yc < -2 + factorioChunkPosition.y ||
                            cachedChunk.yc > 12 + factorioChunkPosition.y)
                    ) {
                        // Outside of bounds, unload
                        console.log(`Unloading chunk x:${cachedChunk.xc} y:${cachedChunk.yc}`)
                        cachedChunk.entities.forEach(entity => {
                            // try {
                                this.removeEntity(entity, false)
                            // } catch (e) {
                                //console.error(e)
                                //console.error(entity)
                            // }
                        })
                        cachedChunk.entities = []
                    }
                })
                // G.BPC.viewport.middle
            }, 3000)
        }
        return this
    }
    getChunk(xc, yc) {
        let cachedChunk = window.fetchedChunks.find(chunk => chunk.xc === xc && chunk.yc === yc)
        if (cachedChunk && cachedChunk.entities < cachedChunk.chunkData) {
            console.log(`Loading cached chunk ${JSON.stringify({ x: xc, y: yc })}`)
            cachedChunk.chunkData.forEach((entity, i) => {
                cachedChunk.entities.push(
                    this.createEntity(
                        {
                            name: entity.name,
                            entity_number: posToId({ x: Number(entity.x) + 2000, y: Number(entity.y) + 2000 }),
                            position: { x: Number(entity.x) + 2000, y: Number(entity.y) + 2000 },
                            direction: entity.direction
                        },
                        false,
                        cachedChunk.chunkData.length === i - 1 // Should we resort entities after Z index? Expensive call
                    )
                )
            } 
        } else if(cachedChunk){} else {
            console.log(`Loading chunk ${JSON.stringify({ x: xc, y: yc })}`)
            this.socket.emit('getChunk', { x: xc, y: yc }, chunkData => {
                let cachedChunk = { xc, yc, chunkData, entities: [] }
                window.fetchedChunks.push(cachedChunk)
                chunkData.forEach((entity, i) => {
                    // console.log(`Drawing entity ${JSON.stringify(entity)}`)
                    cachedChunk.entities.push(
                        this.createEntity(
                            {
                                name: entity.name,
                                entity_number: posToId({ x: Number(entity.x) + 2000, y: Number(entity.y) + 2000 }),
                                position: { x: Number(entity.x) + 2000, y: Number(entity.y) + 2000 },
                                direction: entity.direction
                            },
                            false,
                            chunkData.length === i - 1 // Should we resort entities after Z index? Expensive call
                        )
                    )
                })
            })
        }
    }
    createEntity(rawData: IEntityData, notifyServer: boolean = true, sort: boolean = true) {
        if (
            ['coal', 'stone', 'rock_huge', 'rock_big', 'sand_rock_big', 'iron_ore', 'copper_ore'].includes(rawData.name)
        ) {
            return false
        }
        rawData.entity_number = posToId({
            x: rawData.position.x,
            y: rawData.position.y
        })
        const rawEntity = new Entity(
            {
                ...rawData,
                entity_number: rawData.entity_number ? rawData.entity_number : this.nextEntityNumber
            },
            this
        )

        History.updateMap(this.entities, rawEntity.entityNumber, rawEntity, `Added entity: ${rawEntity.name}`)
            .type('add')
            .emit((newValue: Entity, oldValue: Entity) =>
                this.onCreateOrRemoveEntity(newValue, oldValue, notifyServer, sort, false)
            )
            .commit()

        return rawEntity
    }

    removeEntity(entity: Entity, notifyServer: boolean = true) {
        History.startTransaction(`Deleted entity: ${entity.name}`)
        console.log(`Deleted entity, notify server? ${notifyServer ? 'yes' : 'no'}`)
        entity.removeAllConnections()

        History.updateMap(this.entities, entity.entityNumber, undefined, undefined, true)
            .type('del')
            .emit((newValue: Entity, oldValue: Entity) =>{
                if(newValue === undefined && oldValue === undefined) throw new Error("OldValue is undefined????")
                this.onCreateOrRemoveEntity(newValue, oldValue, notifyServer, undefined, false)
            })

        History.commitTransaction()
    }

    fastReplaceEntity(entity: Entity, name: string, direction: number) {
        History.startTransaction(`Fast replaced entity: ${entity.name}`)

        this.removeEntity(entity)

        // TODO: keep wire connections
        this.createEntity({
            name,
            direction,
            position: entity.position
        }).pasteSettings(entity)

        History.commitTransaction()
    }

    onCreateOrRemoveEntity(
        newValue: Entity,
        oldValue: Entity,
        notifyServer: boolean = true,
        sort: boolean = true,
        dontUpdateWires: boolean = false
    ) {
        if (newValue === undefined) {
            // remoteMap sync changes to factorio server via master
            if (notifyServer) {
                let packet = {
                    entity: {
                        position: idToPos(oldValue.entityNumber)
                    }
                }
                packet.entity.position.x -= 2000
                packet.entity.position.y -= 2000
                this.socket.emit('deleteEntity', packet)
            }
            // delete entity from editor
            this.entityPositionGrid.removeTileData(oldValue)
            oldValue.destroy()
            this.emit('destroy', oldValue, dontUpdateWires)
        } else {
            this.entityPositionGrid.setTileData(newValue)
            this.emit('create', newValue, sort, dontUpdateWires) // Third param is whether to sort, should be run on the last entity in queue

            // remoteMap sync changes to factorio server via master
            if (notifyServer) {
                let packet = {
                    entity: {
                        ...newValue.getRawData(),
                        name: newValue.name.replace(/_/g, '-') // replace _ with -
                    }
                }
                packet.entity.position = {
                    x: packet.entity.position.x - 2000,
                    y: packet.entity.position.y - 2000
                }
                this.socket.emit('createEntity', packet)
            }
        }
    }

    createTiles(name: string, positions: IPoint[]) {
        History.startTransaction(`Added tiles: ${name}`)

        positions.forEach(p => {
            const existingTile = this.tiles.get(`${p.x},${p.y}`)

            if (existingTile && existingTile.name !== name) {
                History.updateMap(this.tiles, existingTile.hash, undefined, undefined, true)
                    .type('del')
                    .emit(this.onCreateOrRemoveTile.bind(this))
            }

            if (!existingTile || (existingTile && existingTile.name !== name)) {
                const tile = new Tile(name, p)

                // TODO: fix the error here, it's because tiles don't have an entity number
                // maybe change the History to accept a function or a variable that will be used as an identifier for logging
                History.updateMap(this.tiles, tile.hash, tile)
                    .type('add')
                    .emit(this.onCreateOrRemoveTile.bind(this))
            }
        })

        History.commitTransaction()
    }

    removeTiles(positions: IPoint[]) {
        History.startTransaction(`Deleted tiles`)

        positions.forEach(p => {
            const tile = this.tiles.get(`${p.x},${p.y}`)
            if (tile) {
                History.updateMap(this.tiles, tile.hash, undefined, undefined, true)
                    .type('del')
                    .emit(this.onCreateOrRemoveTile.bind(this))
            }
        })

        History.commitTransaction()
    }

    onCreateOrRemoveTile(newValue: Tile, oldValue: Tile) {
        if (newValue === undefined) {
            oldValue.destroy()
        } else {
            this.emit('create_t', newValue)
        }
    }

    get nextEntityNumber() {
        const nr = this.m_nextEntityNumber
        this.m_nextEntityNumber += 1
        return nr
    }

    getFirstRail() {
        return this.entities.find(e => e.name === 'straight_rail' /* || e.name === 'curved_rail' */)
    }

    isEmpty() {
        return this.entities.isEmpty() && this.tiles.isEmpty()
    }

    // Get corner/center positions
    getPosition(
        f: 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight',
        xcomp: (i: number, j: number) => number,
        ycomp: (i: number, j: number) => number
    ): IPoint {
        if (this.isEmpty()) {
            return { x: 0, y: 0 }
        }

        const positions = [
            ...[...this.entities.keys()].map(k => this.entities.get(k)[f]()),
            ...[...this.tiles.keys()]
                .map(k => ({ x: Number(k.split(',')[0]), y: Number(k.split(',')[1]) }))
                .map(p => tileCorners(p)[f])
        ]

        return {
            x: positions.map(p => p.x).reduce((p, v) => xcomp(p, v), positions[0].x),
            y: positions.map(p => p.y).reduce((p, v) => ycomp(p, v), positions[0].y)
        }

        function tileCorners(position: IPoint) {
            return {
                topLeft: { x: position.x - 0.5, y: position.y - 0.5 },
                topRight: { x: position.x + 0.5, y: position.y - 0.5 },
                bottomLeft: { x: position.x - 0.5, y: position.y + 0.5 },
                bottomRight: { x: position.x + 0.5, y: position.y + 0.5 }
            }
        }
    }

    center() {
        return {
            x: Math.floor((this.topLeft().x + this.topRight().x) / 2) + 0.5,
            y: Math.floor((this.topLeft().y + this.bottomLeft().y) / 2) + 0.5
        }
    }
    topLeft() {
        return this.getPosition('topLeft', Math.min, Math.min)
    }
    topRight() {
        return this.getPosition('topRight', Math.max, Math.min)
    }
    bottomLeft() {
        return this.getPosition('bottomLeft', Math.min, Math.max)
    }
    bottomRight() {
        return this.getPosition('bottomRight', Math.max, Math.max)
    }

    generatePipes() {
        const DEBUG = G.oilOutpostSettings.DEBUG
        const PUMPJACK_MODULE = G.oilOutpostSettings.PUMPJACK_MODULE
        const MIN_GAP_BETWEEN_UNDERGROUNDS = G.oilOutpostSettings.MIN_GAP_BETWEEN_UNDERGROUNDS
        const MIN_AFFECTED_ENTITIES = G.oilOutpostSettings.MIN_AFFECTED_ENTITIES
        const BEACON_MODULE = G.oilOutpostSettings.BEACON_MODULE
        const BEACONS = G.oilOutpostSettings.BEACONS && BEACON_MODULE !== 'none'

        const pumpjacks = this.entities
            .filter(v => v.name === 'pumpjack')
            .map(p => ({ entity_number: p.entityNumber, name: p.name, position: p.position }))

        if (pumpjacks.length < 2 || pumpjacks.length > 200) {
            console.error('There should be between 2 and 200 pumpjacks in the BP Area!')
            return
        }

        if (pumpjacks.length !== this.entities.size) {
            console.error('BP Area should only contain pumpjacks!')
            return
        }

        console.log('Generating pipes...')

        const T = util.timer('Total generation')

        const GPT = util.timer('Pipe generation')

        // I wrapped generatePipes into a Web Worker but for some reason it sometimes takes x2 time to run the function
        // Usualy when there are more than 100 pumpjacks the function will block the main thread
        // which is not great but the user should wait for the generated entities anyway
        const GP = generators.generatePipes(pumpjacks, MIN_GAP_BETWEEN_UNDERGROUNDS)

        console.log('Pipes:', GP.info.nrOfPipes)
        console.log('Underground Pipes:', GP.info.nrOfUPipes)
        console.log('Pipes replaced by underground pipes:', GP.info.nrOfPipesReplacedByUPipes)
        console.log('Ratio (pipes replaced/underground pipes):', GP.info.nrOfPipesReplacedByUPipes / GP.info.nrOfUPipes)
        GPT.stop()

        const GBT = util.timer('Beacon generation')

        const entitiesForBeaconGen = [
            ...pumpjacks.map(p => ({ ...p, size: 3, effect: true })),
            ...GP.pipes.map(p => ({ ...p, size: 1, effect: false }))
        ]

        const GB = BEACONS ? generators.generateBeacons(entitiesForBeaconGen, MIN_AFFECTED_ENTITIES) : undefined

        if (BEACONS) {
            console.log('Beacons:', GB.info.totalBeacons)
            console.log('Effects given by beacons:', GB.info.effectsGiven)
        }
        GBT.stop()

        const GPOT = util.timer('Pole generation')

        const entitiesForPoleGen = [
            ...pumpjacks.map(p => ({ ...p, size: 3, power: true })),
            ...GP.pipes.map(p => ({ ...p, size: 1, power: false })),
            ...(BEACONS ? GB.beacons.map(p => ({ ...p, size: 3, power: true })) : [])
        ]

        const GPO = generators.generatePoles(entitiesForPoleGen)

        console.log('Power Poles:', GPO.info.totalPoles)
        GPOT.stop()

        T.stop()

        History.startTransaction('Generated Oil Outpost!')

        GP.pipes.forEach(pipe => this.createEntity(pipe))
        if (BEACONS) {
            GB.beacons.forEach(beacon => this.createEntity({ ...beacon, items: { [BEACON_MODULE]: 2 } }))
        }
        GPO.poles.forEach(pole => this.createEntity(pole))

        GP.pumpjacksToRotate.forEach(p => {
            const entity = this.entities.get(p.entity_number)
            entity.direction = p.direction
            if (PUMPJACK_MODULE !== 'none') {
                entity.modules = [PUMPJACK_MODULE, PUMPJACK_MODULE]
            }
        })

        History.commitTransaction()

        if (!DEBUG) {
            return
        }

        // TODO: make a container special for debugging purposes
        G.BPC.wiresContainer.children = []

        const timePerVis = 1000
        ;[GP.visualizations, BEACONS ? GB.visualizations : [], GPO.visualizations]
            .filter(vis => vis.length)
            .forEach((vis, i) => {
                vis.forEach((v, j, arr) => {
                    setTimeout(() => {
                        const tint = v.color ? v.color : 0xffffff * Math.random()
                        v.path.forEach((p, k) => {
                            setTimeout(() => {
                                const s = new PIXI.Sprite(PIXI.Texture.WHITE)
                                s.tint = tint
                                s.anchor.set(0.5)
                                s.alpha = v.alpha
                                s.width = v.size
                                s.height = v.size
                                s.position.set(p.x * 32, p.y * 32)
                                G.BPC.wiresContainer.addChild(s)
                            }, k * (timePerVis / arr.length / v.path.length))
                        })
                    }, j * (timePerVis / arr.length) + i * timePerVis)
                })
            })
    }

    /** behaves like in Factorio 0.17.14 */
    generateIcons() {
        /** returns [iconName, count][] */
        function getIconPairs(tilesOrEntities: (Tile | Entity)[], getItemName: (name: string) => string) {
            return [
                ...tilesOrEntities.reduce((map, tileOrEntity) => {
                    const itemName = getItemName(tileOrEntity.name)
                    return map.set(itemName, map.has(itemName) ? map.get(itemName) + 1 : 0)
                }, new Map<string, number>())
            ]
        }

        if (!this.entities.isEmpty()) {
            const getSize = (name: string) => FD.entities[name].size.width * FD.entities[name].size.height
            const getItemScore = (item: [string, number]) => getSize(item[0]) * item[1]

            const iconPairs = getIconPairs(this.entities.valuesArray(), Entity.getItemName).sort(
                (a, b) => getItemScore(b) - getItemScore(a)
            )

            this.icons[0] = iconPairs[0][0]
            if (
                iconPairs[1] &&
                getSize(iconPairs[1][0]) > 1 &&
                getItemScore(iconPairs[1]) * 2.5 > getItemScore(iconPairs[0])
            ) {
                this.icons[1] = iconPairs[1][0]
            }
        } else if (!this.tiles.isEmpty()) {
            const iconPairs = getIconPairs(this.tiles.valuesArray(), Tile.getItemName).sort((a, b) => b[1] - a[1])

            this.icons[0] = iconPairs[0][0]
        }
    }

    getEntitiesForExport() {
        const entityInfo = this.entities.valuesArray().map(e => e.getRawData())
        let entitiesJSON = JSON.stringify(entityInfo)

        // Tag changed ids with !
        let ID = 1
        entityInfo.forEach(e => {
            entitiesJSON = entitiesJSON.replace(
                new RegExp(`"(entity_number|entity_id)":${e.entity_number}([,}])`, 'g'),
                (_, c, c2) => `"${c}":!${ID}${c2}`
            )
            ID += 1
        })

        // Remove tag and sort
        return JSON.parse(
            entitiesJSON.replace(/"(entity_number|entity_id)":![0-9]+?[,}]/g, s => s.replace('!', ''))
        ).sort((a: BPS.IEntity, b: BPS.IEntity) => a.entity_number - b.entity_number)
    }

    toObject() {
        if (!this.icons.length) {
            this.generateIcons()
        }
        const entityInfo = this.getEntitiesForExport()
        const center = this.center()
        const fR = this.getFirstRail()
        if (fR) {
            center.x += (fR.position.x - center.x) % 2
            center.y += (fR.position.y - center.y) % 2
        }
        for (const e of entityInfo) {
            e.position.x -= center.x
            e.position.y -= center.y
        }
        const tileInfo = [...this.tiles].map(([k, v]) => ({
            position: {
                x: Number(k.split(',')[0]) - Math.floor(center.x) - 0.5,
                y: Number(k.split(',')[1]) - Math.floor(center.y) - 0.5
            },
            name: v.name
        }))
        const iconData = this.icons.map((icon, i) => {
            return { signal: { type: getItemTypeForBp(icon), name: icon }, index: i + 1 }

            function getItemTypeForBp(name: string) {
                switch (FD.items[name].type) {
                    case 'virtual_signal':
                        return 'virtual'
                    case 'fluid':
                        return 'fluid'
                    default:
                        return 'item'
                }
            }
        })
        return {
            blueprint: {
                icons: iconData,
                entities: this.entities.isEmpty() ? undefined : entityInfo,
                tiles: this.tiles.isEmpty() ? undefined : tileInfo,
                item: 'blueprint',
                version: G.getFactorioVersion(),
                label: this.name
            }
        }
    }
}
function posToId(pos: IPoint): number {
    return Number(
        `1${(Math.floor(pos.x) + '').padStart(7, '0')}${(Math.floor(pos.y) + '').padStart(7, '0')}000${Math.floor(
            Math.random() * 999999
        )}`
    )
}
function idToPos(ID: number): IPoint {
    const a = String(ID).substr(1)
    const y = Number(a.substr(7))
    const x = Number(a.substr(0, 7))
    return { x, y }
}
