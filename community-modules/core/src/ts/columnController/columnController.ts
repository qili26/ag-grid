import { ColumnGroup } from '../entities/columnGroup';
import { Column } from '../entities/column';
import { AbstractColDef, ColDef, ColGroupDef, IAggFunc } from '../entities/colDef';
import { ColumnGroupChild } from '../entities/columnGroupChild';
import { GridOptionsWrapper } from '../gridOptionsWrapper';
import { ExpressionService } from '../valueService/expressionService';
import { ColumnFactory } from './columnFactory';
import { DisplayedGroupCreator } from './displayedGroupCreator';
import { AutoWidthCalculator } from '../rendering/autoWidthCalculator';
import { OriginalColumnGroupChild } from '../entities/originalColumnGroupChild';
import { ColumnUtils } from './columnUtils';
import { Logger, LoggerFactory } from '../logger';
import {
    ColumnEvent,
    ColumnEventType,
    ColumnEverythingChangedEvent,
    ColumnGroupOpenedEvent,
    ColumnMovedEvent,
    ColumnPinnedEvent,
    ColumnPivotModeChangedEvent,
    ColumnResizedEvent,
    ColumnRowGroupChangedEvent,
    ColumnValueChangedEvent,
    ColumnVisibleEvent,
    DisplayedColumnsChangedEvent,
    DisplayedColumnsWidthChangedEvent,
    Events,
    GridColumnsChangedEvent,
    NewColumnsLoadedEvent,
    VirtualColumnsChangedEvent
} from '../events';
import { BeanStub } from "../context/beanStub";
import { OriginalColumnGroup } from '../entities/originalColumnGroup';
import { GroupInstanceIdCreator } from './groupInstanceIdCreator';
import { Autowired, Bean, Optional, PostConstruct, Qualifier } from '../context/context';
import { IAggFuncService } from '../interfaces/iAggFuncService';
import { ColumnAnimationService } from '../rendering/columnAnimationService';
import { AutoGroupColService } from './autoGroupColService';
import { RowNode } from '../entities/rowNode';
import { ValueCache } from '../valueService/valueCache';
import { GridApi } from '../gridApi';
import { ApplyColumnStateParams, ColumnApi } from './columnApi';
import { Constants } from '../constants/constants';
import { areEqual, last, removeFromArray, moveInArray, filter, includes, insertIntoArray, removeAllFromArray } from '../utils/array';
import { AnimationFrameService } from "../misc/animationFrameService";
import { SortController } from "../sortController";
import { missingOrEmpty, exists, missing, find, attrToBoolean, attrToNumber } from '../utils/generic';
import { camelCaseToHumanText, startsWith } from '../utils/string';
import { ColumnDefFactory } from "./columnDefFactory";
import { IRowModel } from "../interfaces/iRowModel";
import { IClientSideRowModel } from "../interfaces/iClientSideRowModel";

export interface ColumnResizeSet {
    columns: Column[];
    ratios: number[];
    width: number;
}

export interface ColumnState {
    colId?: string;
    hide?: boolean | null;
    aggFunc?: string | IAggFunc | null;
    width?: number | undefined;
    pivot?: boolean | null;
    pivotIndex?: number | null;
    pinned?: boolean | string | 'left' | 'right' | null;
    rowGroup?: boolean | null;
    rowGroupIndex?: number | null;
    flex?: number | null;
    sort?: string | null;
    sortIndex?: number | null;
}

@Bean('columnController')
export class ColumnController extends BeanStub {

    @Autowired('gridOptionsWrapper') private gridOptionsWrapper: GridOptionsWrapper;
    @Autowired('expressionService') private expressionService: ExpressionService;
    @Autowired('columnFactory') private columnFactory: ColumnFactory;
    @Autowired('displayedGroupCreator') private displayedGroupCreator: DisplayedGroupCreator;
    @Autowired('autoWidthCalculator') private autoWidthCalculator: AutoWidthCalculator;
    @Autowired('columnUtils') private columnUtils: ColumnUtils;
    @Autowired('columnAnimationService') private columnAnimationService: ColumnAnimationService;
    @Autowired('autoGroupColService') private autoGroupColService: AutoGroupColService;
    @Optional('aggFuncService') private aggFuncService: IAggFuncService;
    @Optional('valueCache') private valueCache: ValueCache;
    @Optional('animationFrameService') private animationFrameService: AnimationFrameService;

    @Autowired('rowModel') private rowModel: IRowModel;
    @Autowired('columnApi') private columnApi: ColumnApi;
    @Autowired('gridApi') private gridApi: GridApi;
    @Autowired('sortController') private sortController: SortController;
    @Autowired('columnDefFactory') private columnDefFactory: ColumnDefFactory;

    // these are the columns provided by the client. this doesn't change, even if the
    // order or state of the columns and groups change. it will only change if the client
    // provides a new set of column definitions. otherwise this tree is used to build up
    // the groups for displaying.
    private primaryColumnTree: OriginalColumnGroupChild[];
    // header row count, based on user provided columns
    private primaryHeaderRowCount = 0;
    // all columns provided by the user. basically it's the leaf level nodes of the
    // tree above (originalBalancedTree)
    private primaryColumns: Column[]; // every column available

    // if pivoting, these are the generated columns as a result of the pivot
    private secondaryBalancedTree: OriginalColumnGroupChild[] | null;
    private secondaryColumns: Column[] | null;
    private secondaryHeaderRowCount = 0;
    private secondaryColumnsPresent = false;

    // the columns the quick filter should use. this will be all primary columns
    // plus the autoGroupColumns if any exist
    private columnsForQuickFilter: Column[];

    // these are all columns that are available to the grid for rendering after pivot
    private gridBalancedTree: OriginalColumnGroupChild[];
    private gridColumns: Column[];
    // header row count, either above, or based on pivoting if we are pivoting
    private gridHeaderRowCount = 0;

    private lastPrimaryOrder: Column[];
    private gridColsArePrimary: boolean;

    // these are the columns actually shown on the screen. used by the header renderer,
    // as header needs to know about column groups and the tree structure.
    private displayedLeftColumnTree: ColumnGroupChild[];
    private displayedRightColumnTree: ColumnGroupChild[];
    private displayedCentreColumnTree: ColumnGroupChild[];

    private displayedLeftHeaderRows: { [row: number]: ColumnGroupChild[]; };
    private displayedRightHeaderRows: { [row: number]: ColumnGroupChild[]; };
    private displayedCentreHeaderRows: { [row: number]: ColumnGroupChild[]; };

    // these are the lists used by the rowRenderer to render nodes. almost the leaf nodes of the above
    // displayed trees, however it also takes into account if the groups are open or not.
    private displayedLeftColumns: Column[] = [];
    private displayedRightColumns: Column[] = [];
    private displayedCenterColumns: Column[] = [];
    // all three lists above combined
    private allDisplayedColumns: Column[] = [];
    // same as above, except trimmed down to only columns within the viewport
    private allDisplayedVirtualColumns: Column[] = [];
    private allDisplayedCenterVirtualColumns: Column[] = [];

    // true if we are doing column spanning
    private colSpanActive: boolean;

    // grid columns that have colDef.autoHeight set
    private autoRowHeightColumns: Column[];

    private suppressColumnVirtualisation: boolean;

    private rowGroupColumns: Column[] = [];
    private valueColumns: Column[] = [];
    private pivotColumns: Column[] = [];

    private groupAutoColumns: Column[] | null;

    private groupDisplayColumns: Column[];

    private ready = false;
    private logger: Logger;

    private autoGroupsNeedBuilding = false;
    private forceRecreateAutoGroups = false;

    private pivotMode = false;
    private usingTreeData: boolean;

    // for horizontal visualisation of columns
    private scrollWidth: number;
    private scrollPosition: number;

    private bodyWidth = 0;
    private leftWidth = 0;
    private rightWidth = 0;

    private bodyWidthDirty = true;

    private viewportLeft: number;
    private viewportRight: number;
    private flexViewportWidth: number;

    private columnDefs: (ColDef | ColGroupDef)[];

    private colDefVersion = 0;

    @PostConstruct
    public init(): void {
        this.suppressColumnVirtualisation = this.gridOptionsWrapper.isSuppressColumnVirtualisation();

        const pivotMode = this.gridOptionsWrapper.isPivotMode();

        if (this.isPivotSettingAllowed(pivotMode)) {
            this.pivotMode = pivotMode;
        }

        this.usingTreeData = this.gridOptionsWrapper.isTreeData();

        this.addManagedListener(this.gridOptionsWrapper, 'autoGroupColumnDef', this.onAutoGroupColumnDefChanged.bind(this));
    }

    public onAutoGroupColumnDefChanged() {
        this.autoGroupsNeedBuilding = true;
        this.forceRecreateAutoGroups = true;
        this.updateGridColumns();
        this.updateDisplayedColumns('gridOptionsChanged');
    }

    public getColDefVersion(): number {
        return this.colDefVersion;
    }

    public setColumnDefs(columnDefs: (ColDef | ColGroupDef)[], source: ColumnEventType = 'api') {

        const colsPreviouslyExisted = !!this.columnDefs;

        this.colDefVersion++;

        const raiseEventsFunc = this.compareColumnStatesAndRaiseEvents(source);

        this.columnDefs = columnDefs;

        // always invalidate cache on changing columns, as the column id's for the new columns
        // could overlap with the old id's, so the cache would return old values for new columns.
        this.valueCache.expire();

        // NOTE ==================
        // we should be destroying the existing columns and groups if they exist, for example, the original column
        // group adds a listener to the columns, it should be also removing the listeners
        this.autoGroupsNeedBuilding = true;

        const oldPrimaryColumns = this.primaryColumns;
        const balancedTreeResult = this.columnFactory.createColumnTree(columnDefs, true, oldPrimaryColumns);

        this.primaryColumnTree = balancedTreeResult.columnTree;
        this.primaryHeaderRowCount = balancedTreeResult.treeDept + 1;

        this.primaryColumns = this.getColumnsFromTree(this.primaryColumnTree);

        this.extractRowGroupColumns(source, oldPrimaryColumns);
        this.extractPivotColumns(source, oldPrimaryColumns);
        this.extractValueColumns(source, oldPrimaryColumns);

        this.ready = true;

        this.updateGridColumns();
        if (colsPreviouslyExisted && this.gridColsArePrimary && this.gridOptionsWrapper.isApplyColumnDefOrder()) {
            this.orderGridColumnsLikePrimary();
        }
        this.updateDisplayedColumns(source);
        this.checkDisplayedVirtualColumns();

        const eventEverythingChanged: ColumnEverythingChangedEvent = {
            type: Events.EVENT_COLUMN_EVERYTHING_CHANGED,
            api: this.gridApi,
            columnApi: this.columnApi,
            source
        };

        this.eventService.dispatchEvent(eventEverythingChanged);

        const newColumnsLoadedEvent: NewColumnsLoadedEvent = {
            type: Events.EVENT_NEW_COLUMNS_LOADED,
            api: this.gridApi,
            columnApi: this.columnApi
        };

        raiseEventsFunc();

        this.eventService.dispatchEvent(newColumnsLoadedEvent);
    }

    private orderGridColumnsLikePrimary(): void {
        this.gridColumns.sort((colA: Column, colB: Column) => {
            const primaryIndexA = this.primaryColumns.indexOf(colA);
            const primaryIndexB = this.primaryColumns.indexOf(colB);
            // if both cols are present in primary, then we just return the position,
            // so position is maintained.
            const indexAPresent = primaryIndexA >= 0;
            const indexBPresent = primaryIndexB >= 0;

            if (indexAPresent && indexBPresent) {
                return primaryIndexA - primaryIndexB;
            }

            if (indexAPresent) {
                // B is auto group column, so put B first
                return 1;
            }

            if (indexBPresent) {
                // A is auto group column, so put A first
                return -1;
            }

            // otherwise both A and B are auto-group columns. so we just keep the order
            // as they were already in.
            const gridIndexA = this.gridColumns.indexOf(colA);
            const gridIndexB = this.gridColumns.indexOf(colB);
            return gridIndexA - gridIndexB;
        });
    }

    public isAutoRowHeightActive(): boolean {
        return this.autoRowHeightColumns && this.autoRowHeightColumns.length > 0;
    }

    public getAllAutoRowHeightCols(): Column[] {
        return this.autoRowHeightColumns;
    }

    private setVirtualViewportLeftAndRight(): void {
        if (this.gridOptionsWrapper.isEnableRtl()) {
            this.viewportLeft = this.bodyWidth - this.scrollPosition - this.scrollWidth;
            this.viewportRight = this.bodyWidth - this.scrollPosition;
        } else {
            this.viewportLeft = this.scrollPosition;
            this.viewportRight = this.scrollWidth + this.scrollPosition;
        }
    }

    // used by clipboard service, to know what columns to paste into
    public getDisplayedColumnsStartingAt(column: Column): Column[] {
        let currentColumn: Column | null = column;
        const columns: Column[] = [];

        while (currentColumn != null) {
            columns.push(currentColumn);
            currentColumn = this.getDisplayedColAfter(currentColumn);
        }

        return columns;
    }

    // checks what columns are currently displayed due to column virtualisation. fires an event
    // if the list of columns has changed.
    // + setColumnWidth(), setVirtualViewportPosition(), setColumnDefs(), sizeColumnsToFit()
    private checkDisplayedVirtualColumns(): void {
        // check displayCenterColumnTree exists first, as it won't exist when grid is initialising
        if (this.displayedCenterColumns == null) { return; }

        const hashBefore = this.allDisplayedVirtualColumns.map(column => column.getId()).join('#');

        this.updateVirtualSets();

        const hashAfter = this.allDisplayedVirtualColumns.map(column => column.getId()).join('#');

        if (hashBefore !== hashAfter) {
            const event: VirtualColumnsChangedEvent = {
                type: Events.EVENT_VIRTUAL_COLUMNS_CHANGED,
                api: this.gridApi,
                columnApi: this.columnApi
            };

            this.eventService.dispatchEvent(event);
        }
    }

    public setVirtualViewportPosition(scrollWidth: number, scrollPosition: number): void {
        if (scrollWidth !== this.scrollWidth || scrollPosition !== this.scrollPosition || this.bodyWidthDirty) {
            this.scrollWidth = scrollWidth;
            this.scrollPosition = scrollPosition;
            // we need to call setVirtualViewportLeftAndRight() at least once after the body width changes,
            // as the viewport can stay the same, but in RTL, if body width changes, we need to work out the
            // virtual columns again
            this.bodyWidthDirty = true;
            this.setVirtualViewportLeftAndRight();

            if (this.ready) {
                this.checkDisplayedVirtualColumns();
            }
        }
    }

    public isPivotMode(): boolean {
        return this.pivotMode;
    }

    private isPivotSettingAllowed(pivot: boolean): boolean {
        if (pivot && this.gridOptionsWrapper.isTreeData()) {
            console.warn("ag-Grid: Pivot mode not available in conjunction Tree Data i.e. 'gridOptions.treeData: true'");
            return false;
        }

        return true;
    }

    public setPivotMode(pivotMode: boolean, source: ColumnEventType = 'api'): void {
        if (pivotMode === this.pivotMode || !this.isPivotSettingAllowed(this.pivotMode)) { return; }

        this.pivotMode = pivotMode;

        // we need to update grid columns to cover the scenario where user has groupSuppressAutoColumn=true, as
        // this means we don't use auto group column UNLESS we are in pivot mode (it's mandatory in pivot mode),
        // so need to updateGridColumn() to check it autoGroupCol needs to be added / removed
        this.autoGroupsNeedBuilding = true;
        this.updateGridColumns();
        this.updateDisplayedColumns(source);

        const event: ColumnPivotModeChangedEvent = {
            type: Events.EVENT_COLUMN_PIVOT_MODE_CHANGED,
            api: this.gridApi,
            columnApi: this.columnApi
        };

        this.eventService.dispatchEvent(event);
    }

    public getSecondaryPivotColumn(pivotKeys: string[], valueColKey: Column | string): Column | null {
        if (!this.secondaryColumnsPresent || !this.secondaryColumns) { return null; }

        const valueColumnToFind = this.getPrimaryColumn(valueColKey);

        let foundColumn: Column | null = null;

        this.secondaryColumns.forEach(column => {
            const thisPivotKeys = column.getColDef().pivotKeys;
            const pivotValueColumn = column.getColDef().pivotValueColumn;

            const pivotKeyMatches = areEqual(thisPivotKeys, pivotKeys);
            const pivotValueMatches = pivotValueColumn === valueColumnToFind;

            if (pivotKeyMatches && pivotValueMatches) {
                foundColumn = column;
            }
        });

        return foundColumn;
    }

    private setBeans(@Qualifier('loggerFactory') loggerFactory: LoggerFactory) {
        this.logger = loggerFactory.create('ColumnController');
    }

    private setFirstRightAndLastLeftPinned(source: ColumnEventType): void {
        let lastLeft: Column | null;
        let firstRight: Column | null;

        if (this.gridOptionsWrapper.isEnableRtl()) {
            lastLeft = this.displayedLeftColumns ? this.displayedLeftColumns[0] : null;
            firstRight = this.displayedRightColumns ? last(this.displayedRightColumns) : null;
        } else {
            lastLeft = this.displayedLeftColumns ? last(this.displayedLeftColumns) : null;
            firstRight = this.displayedRightColumns ? this.displayedRightColumns[0] : null;
        }

        this.gridColumns.forEach((column: Column) => {
            column.setLastLeftPinned(column === lastLeft, source);
            column.setFirstRightPinned(column === firstRight, source);
        });
    }

    public autoSizeColumns(keys: (string | Column)[], skipHeader?: boolean, source: ColumnEventType = "api"): void {
        // because of column virtualisation, we can only do this function on columns that are
        // actually rendered, as non-rendered columns (outside the viewport and not rendered
        // due to column virtualisation) are not present. this can result in all rendered columns
        // getting narrowed, which in turn introduces more rendered columns on the RHS which
        // did not get autosized in the original run, leaving the visible grid with columns on
        // the LHS sized, but RHS no. so we keep looping through the visible columns until
        // no more cols are available (rendered) to be resized

        // we autosize after animation frames finish in case any cell renderers need to complete first. this can
        // happen eg if client code is calling api.autoSizeAllColumns() straight after grid is initialised, but grid
        // hasn't fully drawn out all the cells yet (due to cell renderers in animation frames).
        this.animationFrameService.flushAllFrames();

        // keep track of which cols we have resized in here
        const columnsAutosized: Column[] = [];
        // initialise with anything except 0 so that while loop executes at least once
        let changesThisTimeAround = -1;

        if (skipHeader == null) {
            skipHeader = this.gridOptionsWrapper.isSkipHeaderOnAutoSize();
        }

        while (changesThisTimeAround !== 0) {
            changesThisTimeAround = 0;
            this.actionOnGridColumns(keys, (column: Column): boolean => {
                // if already autosized, skip it
                if (columnsAutosized.indexOf(column) >= 0) {
                    return false;
                }
                // get how wide this col should be
                const preferredWidth = this.autoWidthCalculator.getPreferredWidthForColumn(column, skipHeader);
                // preferredWidth = -1 if this col is not on the screen
                if (preferredWidth > 0) {
                    const newWidth = this.normaliseColumnWidth(column, preferredWidth);
                    column.setActualWidth(newWidth, source);
                    columnsAutosized.push(column);
                    changesThisTimeAround++;
                }
                return true;
            }, source);
        }

        this.fireColumnResizedEvent(columnsAutosized, true, 'autosizeColumns');
    }

    public fireColumnResizedEvent(columns: Column[], finished: boolean, source: ColumnEventType, flexColumns: Column[] = null): void {
        if (columns && columns.length) {
            const event: ColumnResizedEvent = {
                type: Events.EVENT_COLUMN_RESIZED,
                columns: columns,
                column: columns.length === 1 ? columns[0] : null,
                flexColumns: flexColumns,
                finished: finished,
                api: this.gridApi,
                columnApi: this.columnApi,
                source: source
            };
            this.eventService.dispatchEvent(event);
        }
    }

    public autoSizeColumn(key: string | Column | null, skipHeader?: boolean, source: ColumnEventType = "api"): void {
        if (key) {
            this.autoSizeColumns([key], skipHeader, source);
        }
    }

    public autoSizeAllColumns(skipHeader?: boolean, source: ColumnEventType = "api"): void {
        const allDisplayedColumns = this.getAllDisplayedColumns();
        this.autoSizeColumns(allDisplayedColumns, skipHeader, source);
    }

    private getColumnsFromTree(rootColumns: OriginalColumnGroupChild[]): Column[] {
        const result: Column[] = [];

        const recursiveFindColumns = (childColumns: OriginalColumnGroupChild[]): void => {
            for (let i = 0; i < childColumns.length; i++) {
                const child = childColumns[i];
                if (child instanceof Column) {
                    result.push(child);
                } else if (child instanceof OriginalColumnGroup) {
                    recursiveFindColumns(child.getChildren());
                }
            }
        };

        recursiveFindColumns(rootColumns);

        return result;
    }

    public getAllDisplayedColumnGroups(): ColumnGroupChild[] | null {
        if (this.displayedLeftColumnTree && this.displayedRightColumnTree && this.displayedCentreColumnTree) {
            return this.displayedLeftColumnTree
                .concat(this.displayedCentreColumnTree)
                .concat(this.displayedRightColumnTree);
        }

        return null;
    }

    // + columnSelectPanel
    public getPrimaryColumnTree(): OriginalColumnGroupChild[] {
        return this.primaryColumnTree;
    }

    // + gridPanel -> for resizing the body and setting top margin
    public getHeaderRowCount(): number {
        return this.gridHeaderRowCount;
    }

    // + headerRenderer -> setting pinned body width
    public getLeftDisplayedColumnGroups(): ColumnGroupChild[] {
        return this.displayedLeftColumnTree;
    }

    // + headerRenderer -> setting pinned body width
    public getRightDisplayedColumnGroups(): ColumnGroupChild[] {
        return this.displayedRightColumnTree;
    }

    // + headerRenderer -> setting pinned body width
    public getCenterDisplayedColumnGroups(): ColumnGroupChild[] {
        return this.displayedCentreColumnTree;
    }

    public getDisplayedColumnGroups(type: string): ColumnGroupChild[] {
        switch (type) {
            case Constants.PINNED_LEFT:
                return this.getLeftDisplayedColumnGroups();
            case Constants.PINNED_RIGHT:
                return this.getRightDisplayedColumnGroups();
            default:
                return this.getCenterDisplayedColumnGroups();
        }
    }

    // gridPanel -> ensureColumnVisible
    public isColumnDisplayed(column: Column): boolean {
        return this.getAllDisplayedColumns().indexOf(column) >= 0;
    }

    // + csvCreator
    public getAllDisplayedColumns(): Column[] {
        return this.allDisplayedColumns;
    }

    public getAllDisplayedVirtualColumns(): Column[] {
        return this.allDisplayedVirtualColumns;
    }

    public getDisplayedLeftColumnsForRow(rowNode: RowNode): Column[] {
        if (!this.colSpanActive) {
            return this.displayedLeftColumns;
        }

        return this.getDisplayedColumnsForRow(rowNode, this.displayedLeftColumns);
    }

    public getDisplayedRightColumnsForRow(rowNode: RowNode): Column[] {
        if (!this.colSpanActive) {
            return this.displayedRightColumns;
        }

        return this.getDisplayedColumnsForRow(rowNode, this.displayedRightColumns);
    }

    private getDisplayedColumnsForRow(
        rowNode: RowNode, displayedColumns: Column[],
        filterCallback?: (column: Column) => boolean,
        emptySpaceBeforeColumn?: (column: Column) => boolean
    ): Column[] {

        const result: Column[] = [];
        let lastConsideredCol: Column | null = null;

        for (let i = 0; i < displayedColumns.length; i++) {
            const col = displayedColumns[i];
            const maxAllowedColSpan = displayedColumns.length - i;
            const colSpan = Math.min(col.getColSpan(rowNode), maxAllowedColSpan);
            const columnsToCheckFilter: Column[] = [col];

            if (colSpan > 1) {
                const colsToRemove = colSpan - 1;

                for (let j = 1; j <= colsToRemove; j++) {
                    columnsToCheckFilter.push(displayedColumns[i + j]);
                }

                i += colsToRemove;
            }

            // see which cols we should take out for column virtualisation
            let filterPasses: boolean;

            if (filterCallback) {
                // if user provided a callback, means some columns may not be in the viewport.
                // the user will NOT provide a callback if we are talking about pinned areas,
                // as pinned areas have no horizontal scroll and do not virtualise the columns.
                // if lots of columns, that means column spanning, and we set filterPasses = true
                // if one or more of the columns spanned pass the filter.
                filterPasses = false;
                columnsToCheckFilter.forEach(colForFilter => {
                    if (filterCallback(colForFilter)) { filterPasses = true; }
                });
            } else {
                filterPasses = true;
            }

            if (filterPasses) {
                if (result.length === 0 && lastConsideredCol) {
                    const gapBeforeColumn = emptySpaceBeforeColumn ? emptySpaceBeforeColumn(col) : false;
                    if (gapBeforeColumn) {
                        result.push(lastConsideredCol);
                    }
                }
                result.push(col);
            }

            lastConsideredCol = col;
        }

        return result;
    }

    // + rowRenderer
    // if we are not column spanning, this just returns back the virtual centre columns,
    // however if we are column spanning, then different rows can have different virtual
    // columns, so we have to work out the list for each individual row.
    public getAllDisplayedCenterVirtualColumnsForRow(rowNode: RowNode): Column[] {
        if (!this.colSpanActive) {
            return this.allDisplayedCenterVirtualColumns;
        }

        const emptySpaceBeforeColumn = (col: Column) => col.getLeft() > this.viewportLeft;

        // if doing column virtualisation, then we filter based on the viewport.
        const filterCallback = this.suppressColumnVirtualisation ? null : this.isColumnInViewport.bind(this);

        return this.getDisplayedColumnsForRow(
            rowNode,
            this.displayedCenterColumns,
            filterCallback,
            emptySpaceBeforeColumn
        );
    }

    public getAriaColumnIndex(col: Column): number {
        return this.getAllGridColumns().indexOf(col) + 1;
    }

    private isColumnInViewport(col: Column): boolean {
        const columnLeft = col.getLeft();
        const columnRight = col.getLeft() + col.getActualWidth();

        // adding 200 for buffer size, so some cols off viewport are rendered.
        // this helps horizontal scrolling so user rarely sees white space (unless
        // they scroll horizontally fast). however we are conservative, as the more
        // buffer the slower the vertical redraw speed
        const leftBounds = this.viewportLeft - 200;
        const rightBounds = this.viewportRight + 200;

        const columnToMuchLeft = columnLeft < leftBounds && columnRight < leftBounds;
        const columnToMuchRight = columnLeft > rightBounds && columnRight > rightBounds;

        return !columnToMuchLeft && !columnToMuchRight;
    }

    // used by:
    // + angularGrid -> setting pinned body width
    // note: this should be cached
    public getPinnedLeftContainerWidth() {
        return this.getWidthOfColsInList(this.displayedLeftColumns);
    }

    // note: this should be cached
    public getPinnedRightContainerWidth() {
        return this.getWidthOfColsInList(this.displayedRightColumns);
    }

    public updatePrimaryColumnList(
        keys: (string | Column)[] | null,
        masterList: Column[],
        actionIsAdd: boolean,
        columnCallback: (column: Column) => void,
        eventType: string,
        source: ColumnEventType = "api"
    ) {

        if (!keys || missingOrEmpty(keys)) { return; }

        let atLeastOne = false;

        keys.forEach(key => {
            const columnToAdd = this.getPrimaryColumn(key);
            if (!columnToAdd) { return; }

            if (actionIsAdd) {
                if (masterList.indexOf(columnToAdd) >= 0) { return; }
                masterList.push(columnToAdd);
            } else {
                if (masterList.indexOf(columnToAdd) < 0) { return; }
                removeFromArray(masterList, columnToAdd);
            }

            columnCallback(columnToAdd);
            atLeastOne = true;
        });

        if (!atLeastOne) { return; }

        if (this.autoGroupsNeedBuilding) {
            this.updateGridColumns();
        }

        this.updateDisplayedColumns(source);

        const event: ColumnEvent = {
            type: eventType,
            columns: masterList,
            column: masterList.length === 1 ? masterList[0] : null,
            api: this.gridApi,
            columnApi: this.columnApi,
            source: source
        };

        this.eventService.dispatchEvent(event);
    }

    public setRowGroupColumns(colKeys: (string | Column)[], source: ColumnEventType = "api"): void {
        this.autoGroupsNeedBuilding = true;
        this.setPrimaryColumnList(colKeys, this.rowGroupColumns,
            Events.EVENT_COLUMN_ROW_GROUP_CHANGED,
            this.setRowGroupActive.bind(this),
            source);
    }

    private setRowGroupActive(active: boolean, column: Column, source: ColumnEventType): void {
        if (active === column.isRowGroupActive()) { return; }

        column.setRowGroupActive(active, source);

        if (!active && !this.gridOptionsWrapper.isSuppressMakeColumnVisibleAfterUnGroup()) {
            column.setVisible(true, source);
        }
    }

    public addRowGroupColumn(key: string | Column | null, source: ColumnEventType = "api"): void {
        if (key) { this.addRowGroupColumns([key], source); }
    }

    public addRowGroupColumns(keys: (string | Column)[], source: ColumnEventType = "api"): void {
        this.autoGroupsNeedBuilding = true;
        this.updatePrimaryColumnList(keys, this.rowGroupColumns, true,
            this.setRowGroupActive.bind(this, true),
            Events.EVENT_COLUMN_ROW_GROUP_CHANGED,
            source);
    }

    public removeRowGroupColumns(keys: (string | Column)[] | null, source: ColumnEventType = "api"): void {
        this.autoGroupsNeedBuilding = true;
        this.updatePrimaryColumnList(keys, this.rowGroupColumns, false,
            this.setRowGroupActive.bind(this, false),
            Events.EVENT_COLUMN_ROW_GROUP_CHANGED,
            source);
    }

    public removeRowGroupColumn(key: string | Column | null, source: ColumnEventType = "api"): void {
        if (key) { this.removeRowGroupColumns([key], source); }
    }

    public addPivotColumns(keys: (string | Column)[], source: ColumnEventType = "api"): void {
        this.updatePrimaryColumnList(keys, this.pivotColumns, true,
            column => column.setPivotActive(true, source),
            Events.EVENT_COLUMN_PIVOT_CHANGED, source);
    }

    public setPivotColumns(colKeys: (string | Column)[], source: ColumnEventType = "api"): void {
        this.setPrimaryColumnList(colKeys, this.pivotColumns, Events.EVENT_COLUMN_PIVOT_CHANGED,
            (added: boolean, column: Column) => {
                column.setPivotActive(added, source);
            }, source
        );
    }

    public addPivotColumn(key: string | Column, source: ColumnEventType = "api"): void {
        this.addPivotColumns([key], source);
    }

    public removePivotColumns(keys: (string | Column)[], source: ColumnEventType = "api"): void {
        this.updatePrimaryColumnList(
            keys,
            this.pivotColumns,
            false,
            column => column.setPivotActive(false, source),
            Events.EVENT_COLUMN_PIVOT_CHANGED,
            source
        );
    }

    public removePivotColumn(key: string | Column, source: ColumnEventType = "api"): void {
        this.removePivotColumns([key], source);
    }

    private setPrimaryColumnList(
        colKeys: (string | Column)[],
        masterList: Column[],
        eventName: string,
        columnCallback: (added: boolean, column: Column) => void,
        source: ColumnEventType
    ): void {

        masterList.length = 0;

        if (exists(colKeys)) {
            colKeys.forEach(key => {
                const column = this.getPrimaryColumn(key);
                if (column) {
                    masterList.push(column);
                }
            });
        }

        this.primaryColumns.forEach(column => {
            const added = masterList.indexOf(column) >= 0;
            columnCallback(added, column);
        });

        if (this.autoGroupsNeedBuilding) {
            this.updateGridColumns();
        }

        this.updateDisplayedColumns(source);

        const event: ColumnEvent = {
            type: eventName,
            columns: masterList,
            column: masterList.length === 1 ? masterList[0] : null,
            api: this.gridApi,
            columnApi: this.columnApi,
            source: source
        };

        this.eventService.dispatchEvent(event);
    }

    public setValueColumns(colKeys: (string | Column)[], source: ColumnEventType = "api"): void {
        this.setPrimaryColumnList(colKeys, this.valueColumns,
            Events.EVENT_COLUMN_VALUE_CHANGED,
            this.setValueActive.bind(this),
            source
        );
    }

    private setValueActive(active: boolean, column: Column, source: ColumnEventType): void {
        if (active === column.isValueActive()) { return; }

        column.setValueActive(active, source);

        if (active && !column.getAggFunc()) {
            const initialAggFunc = this.aggFuncService.getDefaultAggFunc(column);
            column.setAggFunc(initialAggFunc);
        }
    }

    public addValueColumns(keys: (string | Column)[], source: ColumnEventType = "api"): void {
        this.updatePrimaryColumnList(keys, this.valueColumns, true,
            this.setValueActive.bind(this, true),
            Events.EVENT_COLUMN_VALUE_CHANGED,
            source
        );
    }

    public addValueColumn(colKey: (string | Column) | null | undefined, source: ColumnEventType = "api"): void {
        if (colKey) { this.addValueColumns([colKey], source); }
    }

    public removeValueColumn(colKey: (string | Column), source: ColumnEventType = "api"): void {
        this.removeValueColumns([colKey], source);
    }

    public removeValueColumns(keys: (string | Column)[], source: ColumnEventType = "api"): void {
        this.updatePrimaryColumnList(keys, this.valueColumns, false,
            this.setValueActive.bind(this, false),
            Events.EVENT_COLUMN_VALUE_CHANGED,
            source
        );
    }

    // returns the width we can set to this col, taking into consideration min and max widths
    private normaliseColumnWidth(column: Column, newWidth: number): number {
        if (newWidth < column.getMinWidth()) {
            newWidth = column.getMinWidth();
        }

        if (column.isGreaterThanMax(newWidth)) {
            newWidth = column.getMaxWidth();
        }

        return newWidth;
    }

    private getPrimaryOrGridColumn(key: string | Column): Column | null {
        const column = this.getPrimaryColumn(key);

        return column || this.getGridColumn(key);
    }

    public setColumnWidths(
        columnWidths: {
            key: string | Column, // @key - the column who's size we want to change
            newWidth: number; // @newWidth - width in pixels
        }[],
        shiftKey: boolean, // @takeFromAdjacent - if user has 'shift' pressed, then pixels are taken from adjacent column
        finished: boolean, // @finished - ends up in the event, tells the user if more events are to come
        source: ColumnEventType = "api"
    ): void {
        const sets: ColumnResizeSet[] = [];

        columnWidths.forEach(columnWidth => {
            const col = this.getPrimaryOrGridColumn(columnWidth.key);

            if (!col) { return; }

            sets.push({
                width: columnWidth.newWidth,
                ratios: [1],
                columns: [col]
            });

            // if user wants to do shift resize by default, then we invert the shift operation
            const defaultIsShift = this.gridOptionsWrapper.getColResizeDefault() === 'shift';

            if (defaultIsShift) {
                shiftKey = !shiftKey;
            }

            if (shiftKey) {
                const otherCol = this.getDisplayedColAfter(col);
                if (!otherCol) { return; }

                const widthDiff = col.getActualWidth() - columnWidth.newWidth;
                const otherColWidth = otherCol.getActualWidth() + widthDiff;

                sets.push({
                    width: otherColWidth,
                    ratios: [1],
                    columns: [otherCol]
                });
            }
        });

        if (sets.length === 0) { return; }

        this.resizeColumnSets(sets, finished, source);

    }

    private checkMinAndMaxWidthsForSet(columnResizeSet: ColumnResizeSet): boolean {
        const { columns, width } = columnResizeSet;

        // every col has a min width, so sum them all up and see if we have enough room
        // for all the min widths
        let minWidthAccumulated = 0;
        let maxWidthAccumulated = 0;
        let maxWidthActive = true;

        columns.forEach(col => {
            minWidthAccumulated += col.getMinWidth();

            if (col.getMaxWidth() > 0) {
                maxWidthAccumulated += col.getMaxWidth();
            } else {
                // if at least one columns has no max width, it means the group of columns
                // then has no max width, as at least one column can take as much width as possible
                maxWidthActive = false;
            }
        });

        const minWidthPasses = width >= minWidthAccumulated;
        const maxWidthPasses = !maxWidthActive || (width <= maxWidthAccumulated);

        return minWidthPasses && maxWidthPasses;
    }

    // method takes sets of columns and resizes them. either all sets will be resized, or nothing
    // be resized. this is used for example when user tries to resize a group and holds shift key,
    // then both the current group (grows), and the adjacent group (shrinks), will get resized,
    // so that's two sets for this method.
    public resizeColumnSets(
        resizeSets: ColumnResizeSet[],
        finished: boolean,
        source: ColumnEventType
    ): void {
        const passMinMaxCheck = !resizeSets || resizeSets.every(this.checkMinAndMaxWidthsForSet.bind(this));

        if (!passMinMaxCheck) {
            // even though we are not going to resize beyond min/max size, we still need to raise event when finished
            if (finished) {
                const columns = resizeSets && resizeSets.length > 0 ? resizeSets[0].columns : null;
                this.fireColumnResizedEvent(columns, finished, source);
            }

            return; // don't resize!
        }

        const changedCols: Column[] = [];
        const allResizedCols: Column[] = [];

        resizeSets.forEach(set => {
            const { width, columns, ratios } = set;

            // keep track of pixels used, and last column gets the remaining,
            // to cater for rounding errors, and min width adjustments
            const newWidths: { [colId: string]: number; } = {};
            const finishedCols: { [colId: string]: boolean; } = {};

            columns.forEach(col => allResizedCols.push(col));

            // the loop below goes through each col. if a col exceeds it's min/max width,
            // it then gets set to its min/max width and the column is removed marked as 'finished'
            // and the calculation is done again leaving this column out. take for example columns
            // {A, width: 50, maxWidth: 100}
            // {B, width: 50}
            // {C, width: 50}
            // and then the set is set to width 600 - on the first pass the grid tries to set each column
            // to 200. it checks A and sees 200 > 100 and so sets the width to 100. col A is then marked
            // as 'finished' and the calculation is done again with the remaining cols B and C, which end up
            // splitting the remaining 500 pixels.
            let finishedColsGrew = true;
            let loopCount = 0;

            while (finishedColsGrew) {
                loopCount++;
                if (loopCount > 1000) {
                    // this should never happen, but in the future, someone might introduce a bug here,
                    // so we stop the browser from hanging and report bug properly
                    console.error('ag-Grid: infinite loop in resizeColumnSets');
                    break;
                }

                finishedColsGrew = false;

                const subsetCols: Column[] = [];
                const subsetRatios: number[] = [];
                let subsetRatioTotal = 0;
                let pixelsToDistribute = width;

                columns.forEach((col: Column, index: number) => {
                    const thisColFinished = finishedCols[col.getId()];
                    if (thisColFinished) {
                        pixelsToDistribute -= newWidths[col.getId()];
                    } else {
                        subsetCols.push(col);
                        const ratioThisCol = ratios[index];
                        subsetRatioTotal += ratioThisCol;
                        subsetRatios.push(ratioThisCol);
                    }
                });

                // because we are not using all of the ratios (cols can be missing),
                // we scale the ratio. if all columns are included, then subsetRatioTotal=1,
                // and so the ratioScale will be 1.
                const ratioScale = 1 / subsetRatioTotal;

                subsetCols.forEach((col: Column, index: number) => {
                    const lastCol = index === (subsetCols.length - 1);
                    let colNewWidth: number;

                    if (lastCol) {
                        colNewWidth = pixelsToDistribute;
                    } else {
                        colNewWidth = Math.round(ratios[index] * width * ratioScale);
                        pixelsToDistribute -= colNewWidth;
                    }

                    if (colNewWidth < col.getMinWidth()) {
                        colNewWidth = col.getMinWidth();
                        finishedCols[col.getId()] = true;
                        finishedColsGrew = true;
                    } else if (col.getMaxWidth() > 0 && colNewWidth > col.getMaxWidth()) {
                        colNewWidth = col.getMaxWidth();
                        finishedCols[col.getId()] = true;
                        finishedColsGrew = true;
                    }

                    newWidths[col.getId()] = colNewWidth;
                });
            }

            columns.forEach(col => {
                const newWidth = newWidths[col.getId()];
                if (col.getActualWidth() !== newWidth) {
                    col.setActualWidth(newWidth, source);
                    changedCols.push(col);
                }
            });
        });

        // if no cols changed, then no need to update more or send event.
        const atLeastOneColChanged = changedCols.length > 0;

        const flexedCols = this.refreshFlexedColumns({ resizingCols: allResizedCols, skipSetLeft: true });

        if (atLeastOneColChanged) {
            this.setLeftValues(source);
            this.updateBodyWidths();
            this.checkDisplayedVirtualColumns();
        }

        // check for change first, to avoid unnecessary firing of events
        // however we always fire 'finished' events. this is important
        // when groups are resized, as if the group is changing slowly,
        // eg 1 pixel at a time, then each change will fire change events
        // in all the columns in the group, but only one with get the pixel.
        const colsForEvent = allResizedCols.concat(flexedCols);

        if (atLeastOneColChanged || finished) {
            this.fireColumnResizedEvent(colsForEvent, finished, source, flexedCols);
        }
    }

    public setColumnAggFunc(key: string | Column | null | undefined, aggFunc: string, source: ColumnEventType = "api"): void {
        if (!key) { return; }

        const column = this.getPrimaryColumn(key);
        if (!column) { return; }

        column.setAggFunc(aggFunc);
        const event: ColumnValueChangedEvent = {
            type: Events.EVENT_COLUMN_VALUE_CHANGED,
            columns: [column],
            column: column,
            api: this.gridApi,
            columnApi: this.columnApi,
            source: source
        };
        this.eventService.dispatchEvent(event);
    }

    public moveRowGroupColumn(fromIndex: number, toIndex: number, source: ColumnEventType = "api"): void {
        const column = this.rowGroupColumns[fromIndex];

        this.rowGroupColumns.splice(fromIndex, 1);
        this.rowGroupColumns.splice(toIndex, 0, column);

        const event: ColumnRowGroupChangedEvent = {
            type: Events.EVENT_COLUMN_ROW_GROUP_CHANGED,
            columns: this.rowGroupColumns,
            column: this.rowGroupColumns.length === 1 ? this.rowGroupColumns[0] : null,
            api: this.gridApi,
            columnApi: this.columnApi,
            source: source
        };

        this.eventService.dispatchEvent(event);
    }

    public moveColumns(columnsToMoveKeys: (string | Column)[], toIndex: number, source: ColumnEventType = "api"): void {
        this.columnAnimationService.start();

        if (toIndex > this.gridColumns.length - columnsToMoveKeys.length) {
            console.warn('ag-Grid: tried to insert columns in invalid location, toIndex = ' + toIndex);
            console.warn('ag-Grid: remember that you should not count the moving columns when calculating the new index');
            return;
        }

        // we want to pull all the columns out first and put them into an ordered list
        const columnsToMove = this.getGridColumns(columnsToMoveKeys);
        const failedRules = !this.doesMovePassRules(columnsToMove, toIndex);

        if (failedRules) { return; }

        moveInArray(this.gridColumns, columnsToMove, toIndex);
        this.updateDisplayedColumns(source);

        const event: ColumnMovedEvent = {
            type: Events.EVENT_COLUMN_MOVED,
            columns: columnsToMove,
            column: columnsToMove.length === 1 ? columnsToMove[0] : null,
            toIndex: toIndex,
            api: this.gridApi,
            columnApi: this.columnApi,
            source: source
        };

        this.eventService.dispatchEvent(event);
        this.columnAnimationService.finish();
    }

    public doesMovePassRules(columnsToMove: Column[], toIndex: number): boolean {
        // make a copy of what the grid columns would look like after the move
        const proposedColumnOrder = this.gridColumns.slice();
        moveInArray(proposedColumnOrder, columnsToMove, toIndex);

        // then check that the new proposed order of the columns passes all rules
        if (!this.doesMovePassMarryChildren(proposedColumnOrder)) {
            return false;
        }

        if (!this.doesMovePassLockedPositions(proposedColumnOrder)) {
            return false;
        }

        return true;
    }

    // returns the provided cols sorted in same order as they appear in grid columns. eg if grid columns
    // contains [a,b,c,d,e] and col passed is [e,a] then the passed cols are sorted into [a,e]
    public sortColumnsLikeGridColumns(cols: Column[]): void {
        if (!cols || cols.length<=1) { return; }

        const notAllColsInGridColumns = cols.filter( c => this.gridColumns.indexOf(c) < 0).length > 0;
        if (notAllColsInGridColumns) { return; }

        cols.sort( (a: Column, b: Column) => {
            const indexA = this.gridColumns.indexOf(a);
            const indexB = this.gridColumns.indexOf(b);
            return indexA - indexB;
        });
    }

    public doesMovePassLockedPositions(proposedColumnOrder: Column[]): boolean {
        let foundNonLocked = false;
        let rulePassed = true;

        // go though the cols, see if any non-locked appear before any locked
        proposedColumnOrder.forEach(col => {
            if (col.getColDef().lockPosition) {
                if (foundNonLocked) {
                    rulePassed = false;
                }
            } else {
                foundNonLocked = true;
            }
        });

        return rulePassed;
    }

    public doesMovePassMarryChildren(allColumnsCopy: Column[]): boolean {
        let rulePassed = true;

        this.columnUtils.depthFirstOriginalTreeSearch(null, this.gridBalancedTree, child => {
            if (!(child instanceof OriginalColumnGroup)) { return; }

            const columnGroup = child as OriginalColumnGroup;
            const marryChildren = columnGroup.getColGroupDef() && columnGroup.getColGroupDef().marryChildren;

            if (!marryChildren) { return; }

            const newIndexes: number[] = [];
            columnGroup.getLeafColumns().forEach(col => {
                const newColIndex = allColumnsCopy.indexOf(col);
                newIndexes.push(newColIndex);
            });

            const maxIndex = Math.max.apply(Math, newIndexes);
            const minIndex = Math.min.apply(Math, newIndexes);

            // spread is how far the first column in this group is away from the last column
            const spread = maxIndex - minIndex;
            const maxSpread = columnGroup.getLeafColumns().length - 1;

            // if the columns
            if (spread > maxSpread) {
                rulePassed = false;
            }

            // console.log(`maxIndex = ${maxIndex}, minIndex = ${minIndex}, spread = ${spread}, maxSpread = ${maxSpread}, fail = ${spread > (count-1)}`)
            // console.log(allColumnsCopy.map( col => col.getColDef().field).join(','));
        });

        return rulePassed;
    }

    public moveColumn(key: string | Column, toIndex: number, source: ColumnEventType = "api") {
        this.moveColumns([key], toIndex, source);
    }

    public moveColumnByIndex(fromIndex: number, toIndex: number, source: ColumnEventType = "api"): void {
        const column = this.gridColumns[fromIndex];
        this.moveColumn(column, toIndex, source);
    }

    public getColumnDefs(): (ColDef | ColGroupDef)[] {

        const cols = this.primaryColumns.slice();
        if (this.gridColsArePrimary) {
            cols.sort((a: Column, b: Column) => this.gridColumns.indexOf(a) - this.gridColumns.indexOf(b));
        } else if (this.lastPrimaryOrder) {
            cols.sort((a: Column, b: Column) => this.lastPrimaryOrder.indexOf(a) - this.lastPrimaryOrder.indexOf(b));
        }

        return this.columnDefFactory.buildColumnDefs(cols, this.rowGroupColumns, this.pivotColumns);
    }

    // used by:
    // + angularGrid -> for setting body width
    // + rowController -> setting main row widths (when inserting and resizing)
    // need to cache this
    public getBodyContainerWidth(): number {
        return this.bodyWidth;
    }

    public getContainerWidth(pinned: string): number {
        switch (pinned) {
            case Constants.PINNED_LEFT:
                return this.leftWidth;
            case Constants.PINNED_RIGHT:
                return this.rightWidth;
            default:
                return this.bodyWidth;
        }
    }

    // after setColumnWidth or updateGroupsAndDisplayedColumns
    private updateBodyWidths(): void {
        const newBodyWidth = this.getWidthOfColsInList(this.displayedCenterColumns);
        const newLeftWidth = this.getWidthOfColsInList(this.displayedLeftColumns);
        const newRightWidth = this.getWidthOfColsInList(this.displayedRightColumns);

        // this is used by virtual col calculation, for RTL only, as a change to body width can impact displayed
        // columns, due to RTL inverting the y coordinates
        this.bodyWidthDirty = this.bodyWidth !== newBodyWidth;

        const atLeastOneChanged = this.bodyWidth !== newBodyWidth || this.leftWidth !== newLeftWidth || this.rightWidth !== newRightWidth;

        if (atLeastOneChanged) {
            this.bodyWidth = newBodyWidth;
            this.leftWidth = newLeftWidth;
            this.rightWidth = newRightWidth;
            // when this fires, it is picked up by the gridPanel, which ends up in
            // gridPanel calling setWidthAndScrollPosition(), which in turn calls setVirtualViewportPosition()
            const event: DisplayedColumnsWidthChangedEvent = {
                type: Events.EVENT_DISPLAYED_COLUMNS_WIDTH_CHANGED,
                api: this.gridApi,
                columnApi: this.columnApi
            };
            this.eventService.dispatchEvent(event);
        }
    }

    // + rowController
    public getValueColumns(): Column[] {
        return this.valueColumns ? this.valueColumns : [];
    }

    // + rowController
    public getPivotColumns(): Column[] {
        return this.pivotColumns ? this.pivotColumns : [];
    }

    // + clientSideRowModel
    public isPivotActive(): boolean {
        return this.pivotColumns && this.pivotColumns.length > 0 && this.pivotMode;
    }

    // + toolPanel
    public getRowGroupColumns(): Column[] {
        return this.rowGroupColumns ? this.rowGroupColumns : [];
    }

    // + rowController -> while inserting rows
    public getDisplayedCenterColumns(): Column[] {
        return this.displayedCenterColumns;
    }

    // + rowController -> while inserting rows
    public getDisplayedLeftColumns(): Column[] {
        return this.displayedLeftColumns;
    }

    public getDisplayedRightColumns(): Column[] {
        return this.displayedRightColumns;
    }

    public getDisplayedColumns(type: string): Column[] {
        switch (type) {
            case Constants.PINNED_LEFT:
                return this.getDisplayedLeftColumns();
            case Constants.PINNED_RIGHT:
                return this.getDisplayedRightColumns();
            default:
                return this.getDisplayedCenterColumns();
        }
    }

    // used by:
    // + clientSideRowController -> sorting, building quick filter text
    // + headerRenderer -> sorting (clearing icon)
    public getAllPrimaryColumns(): Column[] | null {
        return this.primaryColumns ? this.primaryColumns.slice() : null;
    }

    public getSecondaryColumns(): Column[] | null {
        return this.secondaryColumns ? this.secondaryColumns.slice() : null;
    }

    public getAllColumnsForQuickFilter(): Column[] {
        return this.columnsForQuickFilter;
    }

    // + moveColumnController
    public getAllGridColumns(): Column[] {
        return this.gridColumns;
    }

    public isEmpty(): boolean {
        return missingOrEmpty(this.gridColumns);
    }

    public isRowGroupEmpty(): boolean {
        return missingOrEmpty(this.rowGroupColumns);
    }

    public setColumnVisible(key: string | Column, visible: boolean, source: ColumnEventType = "api"): void {
        this.setColumnsVisible([key], visible, source);
    }

    public setColumnsVisible(keys: (string | Column)[], visible: boolean, source: ColumnEventType = "api"): void {
        this.columnAnimationService.start();

        this.actionOnGridColumns(keys, (column: Column): boolean => {
            if (column.isVisible() !== visible) {
                column.setVisible(visible, source);
                return true;
            }
            return false;
        }, source, () => {
            const event: ColumnVisibleEvent = {
                type: Events.EVENT_COLUMN_VISIBLE,
                visible: visible,
                column: null,
                columns: null,
                api: this.gridApi,
                columnApi: this.columnApi,
                source: source
            };
            return event;
        });
        this.columnAnimationService.finish();
    }

    public setColumnPinned(key: string | Column | null, pinned: string | boolean | null, source: ColumnEventType = "api"): void {
        if (key) {
            this.setColumnsPinned([key], pinned, source);
        }
    }

    public setColumnsPinned(keys: (string | Column)[], pinned: string | boolean | null, source: ColumnEventType = "api"): void {
        if (this.gridOptionsWrapper.getDomLayout() === 'print') {
            console.warn(`Changing the column pinning status is not allowed with domLayout='print'`);
            return;
        }
        this.columnAnimationService.start();

        let actualPinned: string | null;
        if (pinned === true || pinned === Constants.PINNED_LEFT) {
            actualPinned = Constants.PINNED_LEFT;
        } else if (pinned === Constants.PINNED_RIGHT) {
            actualPinned = Constants.PINNED_RIGHT;
        } else {
            actualPinned = null;
        }

        this.actionOnGridColumns(keys, (col: Column): boolean => {
            if (col.getPinned() !== actualPinned) {
                col.setPinned(actualPinned);
                return true;
            }
            return false;
        }, source, () => {
            const event: ColumnPinnedEvent = {
                type: Events.EVENT_COLUMN_PINNED,
                pinned: actualPinned,
                column: null,
                columns: null,
                api: this.gridApi,
                columnApi: this.columnApi,
                source: source
            };
            return event;
        });

        this.columnAnimationService.finish();
    }

    // does an action on a set of columns. provides common functionality for looking up the
    // columns based on key, getting a list of effected columns, and then updated the event
    // with either one column (if it was just one col) or a list of columns
    // used by: autoResize, setVisible, setPinned
    private actionOnGridColumns(// the column keys this action will be on
        keys: (string | Column)[],
        // the action to do - if this returns false, the column was skipped
        // and won't be included in the event
        action: (column: Column) => boolean,
        // should return back a column event of the right type
        source: ColumnEventType,
        createEvent?: () => ColumnEvent): void {

        if (missingOrEmpty(keys)) { return; }

        const updatedColumns: Column[] = [];

        keys.forEach((key: string | Column) => {
            const column = this.getGridColumn(key);
            if (!column) { return; }

            // need to check for false with type (ie !== instead of !=)
            // as not returning anything (undefined) would also be false
            const resultOfAction = action(column);
            if (resultOfAction !== false) {
                updatedColumns.push(column);
            }
        });

        if (!updatedColumns.length) { return; }

        this.updateDisplayedColumns(source);

        if (exists(createEvent) && createEvent) {
            const event = createEvent();

            event.columns = updatedColumns;
            event.column = updatedColumns.length === 1 ? updatedColumns[0] : null;

            this.eventService.dispatchEvent(event);
        }
    }

    public getDisplayedColBefore(col: Column): Column | null {
        const allDisplayedColumns = this.getAllDisplayedColumns();
        const oldIndex = allDisplayedColumns.indexOf(col);

        if (oldIndex > 0) {
            return allDisplayedColumns[oldIndex - 1];
        }

        return null;
    }

    // used by:
    // + rowRenderer -> for navigation
    public getDisplayedColAfter(col: Column): Column | null {
        const allDisplayedColumns = this.getAllDisplayedColumns();
        const oldIndex = allDisplayedColumns.indexOf(col);

        if (oldIndex < (allDisplayedColumns.length - 1)) {
            return allDisplayedColumns[oldIndex + 1];
        }

        return null;
    }

    public getDisplayedGroupAfter(columnGroup: ColumnGroup): ColumnGroup | null {
        return this.getDisplayedGroupAtDirection(columnGroup, 'After');
    }

    public getDisplayedGroupBefore(columnGroup: ColumnGroup): ColumnGroup | null {
        return this.getDisplayedGroupAtDirection(columnGroup, 'Before');
    }

    public getDisplayedGroupAtDirection(columnGroup: ColumnGroup, direction: 'After' | 'Before'): ColumnGroup | null {
        // pick the last displayed column in this group
        const requiredLevel = columnGroup.getOriginalColumnGroup().getLevel() + columnGroup.getPaddingLevel();
        const colGroupLeafColumns = columnGroup.getDisplayedLeafColumns();
        const col: Column | null = direction === 'After' ? last(colGroupLeafColumns) : colGroupLeafColumns[0];
        const getDisplayColMethod: 'getDisplayedColAfter' | 'getDisplayedColBefore' = `getDisplayedCol${direction}` as any;

        while (true) {
            // keep moving to the next col, until we get to another group
            const column = this[getDisplayColMethod](col);

            if (!column) { return null; }

            const groupPointer = this.getColumnGroupAtLevel(column, requiredLevel);

            if (groupPointer !== columnGroup) {
                return groupPointer;
            }
        }
    }

    public getColumnGroupAtLevel(column: Column, level: number): ColumnGroup | null {
        // get group at same level as the one we are looking for
        let groupPointer: ColumnGroup = column.getParent();
        let originalGroupLevel: number;
        let groupPointerLevel: number;

        while (true) {
            const groupPointerOriginalColumnGroup = groupPointer.getOriginalColumnGroup();
            originalGroupLevel = groupPointerOriginalColumnGroup.getLevel();
            groupPointerLevel = groupPointer.getPaddingLevel();

            if (originalGroupLevel + groupPointerLevel <= level) { break; }
            groupPointer = groupPointer.getParent();
        }

        return groupPointer;
    }

    public isPinningLeft(): boolean {
        return this.displayedLeftColumns.length > 0;
    }

    public isPinningRight(): boolean {
        return this.displayedRightColumns.length > 0;
    }

    public getPrimaryAndSecondaryAndAutoColumns(): Column[] {
        const result = this.primaryColumns ? this.primaryColumns.slice(0) : [];

        if (this.groupAutoColumns && exists(this.groupAutoColumns)) {
            this.groupAutoColumns.forEach(col => result.push(col));
        }

        if (this.secondaryColumnsPresent && this.secondaryColumns) {
            this.secondaryColumns.forEach(column => result.push(column));
        }

        return result;
    }

    private createStateItemFromColumn(column: Column): ColumnState {
        const rowGroupIndex = column.isRowGroupActive() ? this.rowGroupColumns.indexOf(column) : null;
        const pivotIndex = column.isPivotActive() ? this.pivotColumns.indexOf(column) : null;
        const aggFunc = column.isValueActive() ? column.getAggFunc() : null;
        const sort = column.getSort() != null ? column.getSort() : null;
        const sortIndex = column.getSortIndex() != null ? column.getSortIndex() : null;
        const flex = column.getFlex() != null && column.getFlex() > 0 ? column.getFlex() : null;

        const res: ColumnState = {
            colId: column.getColId(),
            width: column.getActualWidth(),
            hide: !column.isVisible(),
            pinned: column.getPinned(),
            sort,
            sortIndex,
            aggFunc,
            rowGroup: column.isRowGroupActive(),
            rowGroupIndex,
            pivot: column.isPivotActive(),
            pivotIndex: pivotIndex,
            flex
        };

        return res;
    }

    public getColumnState(): ColumnState[] {
        if (missing(this.primaryColumns) || !this.isAlive()) { return []; }

        const primaryColumnState: ColumnState[]
            = this.primaryColumns.map(this.createStateItemFromColumn.bind(this));

        const groupAutoColumnState: ColumnState[]
            = this.groupAutoColumns
                // if groupAutoCols, then include them
                ? this.groupAutoColumns.map(this.createStateItemFromColumn.bind(this))
                // otherwise no
                : [];

        const columnStateList = groupAutoColumnState.concat(primaryColumnState);

        if (!this.pivotMode) {
            this.orderColumnStateList(columnStateList);
        }

        return columnStateList;
    }

    private orderColumnStateList(columnStateList: any[]): void {
        const gridColumnIds = this.gridColumns.map(column => column.getColId());

        columnStateList.sort((itemA: any, itemB: any) => {
            const posA = gridColumnIds.indexOf(itemA.colId);
            const posB = gridColumnIds.indexOf(itemB.colId);
            return posA - posB;
        });
    }

    public resetColumnState(suppressEverythingEvent = false, source: ColumnEventType = "api"): void {
        // NOTE = there is one bug here that no customer has noticed - if a column has colDef.lockPosition,
        // this is ignored  below when ordering the cols. to work, we should always put lockPosition cols first.
        // As a work around, developers should just put lockPosition columns first in their colDef list.

        // we can't use 'allColumns' as the order might of messed up, so get the primary ordered list
        const primaryColumns = this.getColumnsFromTree(this.primaryColumnTree);
        const columnStates: ColumnState[] = [];

        // we start at 1000, so if user has mix of rowGroup and group specified, it will work with both.
        // eg IF user has ColA.rowGroupIndex=0, ColB.rowGroupIndex=1, ColC.rowGroup=true,
        // THEN result will be ColA.rowGroupIndex=0, ColB.rowGroupIndex=1, ColC.rowGroup=1000
        let letRowGroupIndex = 1000;
        let letPivotIndex = 1000;

        if (primaryColumns) {
            primaryColumns.forEach((column) => {

                const colDef = column.getColDef();

                const sort = colDef.sort != null ? colDef.sort : null;
                const sortIndex = colDef.sortIndex;
                const hide = colDef.hide ? true : false;
                const pinned = colDef.pinned ? colDef.pinned : null;

                const width = colDef.width;
                const flex = colDef.flex != null ? colDef.flex : null;

                let rowGroupIndex: number = colDef.rowGroupIndex;
                let rowGroup: boolean = colDef.rowGroup;
                if (rowGroupIndex == null && (rowGroup == null || rowGroup == false)) {
                    rowGroupIndex = null;
                    rowGroup = null;
                }
                let pivotIndex: number = colDef.pivotIndex;
                let pivot: boolean = colDef.pivot;
                if (pivotIndex == null && (pivot == null || pivot == false)) {
                    pivotIndex = null;
                    pivot = null;
                }
                const aggFunc = colDef.aggFunc != null ? colDef.aggFunc : null;

                const stateItem = {
                    colId: column.getColId(),
                    sort,
                    sortIndex,
                    hide,
                    pinned,

                    width,
                    flex,

                    rowGroup,
                    rowGroupIndex,
                    pivot,
                    pivotIndex,
                    aggFunc,
                };

                if (missing(rowGroupIndex) && rowGroup) {
                    stateItem.rowGroupIndex = letRowGroupIndex++;
                }

                if (missing(pivotIndex) && pivot) {
                    stateItem.pivotIndex = letPivotIndex++;
                }

                columnStates.push(stateItem);
            });
        }

        this.applyColumnState({ state: columnStates, applyOrder: true }, source);
    }

    public applyColumnState(params: ApplyColumnStateParams, source: ColumnEventType = "api"): boolean {
        if (missingOrEmpty(this.primaryColumns)) { return false; }

        const raiseEventsFunc = this.compareColumnStatesAndRaiseEvents(source);

        this.autoGroupsNeedBuilding = true;

        // at the end below, this list will have all columns we got no state for
        const columnsWithNoState = this.primaryColumns.slice();

        let success = true;

        const rowGroupIndexes: { [key: string]: number; } = {};
        const pivotIndexes: { [key: string]: number; } = {};
        const autoGroupColumnStates: ColumnState[] = [];

        const previousRowGroupCols = this.rowGroupColumns.slice();
        const previousPivotCols = this.pivotColumns.slice();

        if (params.state) {
            if (!params.state.forEach) {
                console.warn('ag-Grid: applyColumnState() - the state attribute should be an array, however an array was not found. Please provide an array of items (one for each col you want to change) for state.')
                return;
            }
            params.state.forEach((state: ColumnState) => {
                const groupAutoColumnId = Constants.GROUP_AUTO_COLUMN_ID;
                const colId = state.colId;

                // auto group columns are re-created so deferring syncing with ColumnState
                const isAutoGroupColumn = startsWith(colId, groupAutoColumnId);
                if (isAutoGroupColumn) {
                    autoGroupColumnStates.push(state);
                    return;
                }

                const column = this.getPrimaryColumn(colId);

                if (!column) {
                    // we don't log the failure, as it's possible the user is applying that has extra
                    // cols in it. for example they could of save while row-grouping (so state includes
                    // auto-group column) and then applied state when not grouping (so the auto-group
                    // column would be in the state but no used).
                    success = false;
                } else {
                    this.syncColumnWithStateItem(column, state, params.defaultState, rowGroupIndexes,
                        pivotIndexes, false, source);
                    removeFromArray(columnsWithNoState, column);
                }
            });
        }

        // anything left over, we got no data for, so add in the column as non-value, non-rowGroup and hidden
        columnsWithNoState.forEach(col => {
            this.syncColumnWithStateItem(col, null, params.defaultState, rowGroupIndexes,
                pivotIndexes, false, source);
        });

        // sort the lists according to the indexes that were provided
        const comparator = (indexes: { [key: string]: number; }, oldList: Column[], colA: Column, colB: Column) => {

            const indexA = indexes[colA.getId()];
            const indexB = indexes[colB.getId()];

            const aHasIndex = indexA != null;
            const bHasIndex = indexB != null;

            if (aHasIndex && bHasIndex) {
                // both a and b are new cols with index, so sort on index
                return indexA - indexB;
            } else if (aHasIndex) {
                // a has an index, so it should be before a
                return -1;
            } else if (bHasIndex) {
                // b has an index, so it should be before a
                return 1;
            } else {
                const oldIndexA = oldList.indexOf(colA);
                const oldIndexB = oldList.indexOf(colB);

                const aHasOldIndex = oldIndexA >= 0;
                const bHasOldIndex = oldIndexB >= 0;

                if (aHasOldIndex && bHasOldIndex) {
                    // both a and b are old cols, so sort based on last order
                    return oldIndexA - oldIndexB;
                } else if (aHasOldIndex) {
                    // a is old, b is new, so b is first
                    return -1;
                } else if (bHasOldIndex) {
                    // b is old, a is new, a is first
                    return 1;
                } else {
                    // this bit does matter, means both are new cols but without index
                    return 1;
                }
            }
        };

        this.rowGroupColumns.sort(comparator.bind(this, rowGroupIndexes, previousRowGroupCols));
        this.pivotColumns.sort(comparator.bind(this, pivotIndexes, previousPivotCols));

        this.updateGridColumns();

        // sync newly created auto group columns with ColumnState
        autoGroupColumnStates.forEach(stateItem => {
            const autoCol = this.getAutoColumn(stateItem.colId);
            this.syncColumnWithStateItem(autoCol, stateItem, params.defaultState, null, null, true, source);
        });

        if (this.gridColsArePrimary && params.applyOrder && params.state) {
            const orderOfColIds = params.state.map(stateItem => stateItem.colId);

            this.gridColumns.sort((colA: Column, colB: Column) => {
                const indexA = orderOfColIds.indexOf(colA.getId());
                const indexB = orderOfColIds.indexOf(colB.getId());

                return indexA - indexB;
            });

            // this is already done in updateGridColumns, however we changed the order above (to match the order of the state
            // columns) so we need to do it again. we could of put logic into the order above to take into account fixed
            // columns, however if we did then we would have logic for updating fixed columns twice. reusing the logic here
            // is less sexy for the code here, but it keeps consistency.
            this.putFixedColumnsFirst();
        }

        this.updateDisplayedColumns(source);

        const event: ColumnEverythingChangedEvent = {
            type: Events.EVENT_COLUMN_EVERYTHING_CHANGED,
            api: this.gridApi,
            columnApi: this.columnApi,
            source: source
        };
        this.eventService.dispatchEvent(event);

        raiseEventsFunc();

        return success;
    }

    private compareColumnStatesAndRaiseEvents(source: ColumnEventType): () => void {

        // if no columns to begin with, then it means we are setting columns for the first time, so
        // there should be no events fired to show differences in columns.
        const colsPreviouslyExisted = !!this.columnDefs;
        if (!colsPreviouslyExisted) {
            return () => {};
        }

        const startState = {
            rowGroupColumns: this.rowGroupColumns.slice(),
            pivotColumns: this.pivotColumns.slice(),
            valueColumns: this.valueColumns.slice()
        };

        const columnStateBefore = this.getColumnState();
        const columnStateBeforeMap: { [colId: string]: ColumnState; } = {};

        columnStateBefore.forEach(col => {
            columnStateBeforeMap[col.colId] = col;
        });

        return () => {

            if (this.gridOptionsWrapper.isSuppressColumnStateEvents()) { return; }

            // raises generic ColumnEvents where all columns are returned rather than what has changed
            const raiseWhenListsDifferent = (eventType: string, colsBefore: Column[], colsAfter: Column[], idMapper: (column: Column) => string) => {

                const beforeList = colsBefore.map(idMapper).sort();
                const afterList = colsAfter.map(idMapper).sort();
                const unchanged = areEqual(beforeList, afterList);

                if (unchanged) { return; }

                // returning all columns rather than what has changed!
                const event: ColumnEvent = {
                    type: eventType,
                    columns: colsAfter,
                    column: colsAfter.length === 1 ? colsAfter[0] : null,
                    api: this.gridApi,
                    columnApi: this.columnApi,
                    source: source
                };

                this.eventService.dispatchEvent(event);
            };

            // determines which columns have changed according to supplied predicate
            const getChangedColumns = (changedPredicate: (cs: ColumnState, c: Column) => boolean): Column[] => {
                const changedColumns: Column[] = [];

                this.gridColumns.forEach(column => {
                    const colStateBefore = columnStateBeforeMap[column.getColId()];
                    if (colStateBefore && changedPredicate(colStateBefore, column)) {
                        changedColumns.push(column);
                    }
                });

                return changedColumns;
            };

            const columnIdMapper = (c: Column) => c.getColId();

            raiseWhenListsDifferent(Events.EVENT_COLUMN_ROW_GROUP_CHANGED,
                startState.rowGroupColumns,
                this.rowGroupColumns,
                columnIdMapper
            );

            raiseWhenListsDifferent(Events.EVENT_COLUMN_PIVOT_CHANGED,
                startState.pivotColumns,
                this.pivotColumns,
                columnIdMapper
            );

            raiseWhenListsDifferent(Events.EVENT_COLUMN_VALUE_CHANGED,
                startState.valueColumns,
                this.valueColumns,
                columnIdMapper
            );

            const resizeChangePredicate = (cs: ColumnState, c: Column) => cs.width != c.getActualWidth();
            this.fireColumnResizedEvent(getChangedColumns(resizeChangePredicate), true, source);

            const pinnedChangePredicate = (cs: ColumnState, c: Column) => cs.pinned != c.getPinned();
            this.raiseColumnPinnedEvent(getChangedColumns(pinnedChangePredicate), source);

            const visibilityChangePredicate = (cs: ColumnState, c: Column) => cs.hide == c.isVisible();
            this.raiseColumnVisibleEvent(getChangedColumns(visibilityChangePredicate), source);

            const sortChangePredicate = (cs: ColumnState, c: Column) => cs.sort != c.getSort();
            if (getChangedColumns(sortChangePredicate).length > 0) {
                this.sortController.dispatchSortChangedEvents();
            }

            // special handling for moved column events
            this.raiseColumnMovedEvent(columnStateBefore, source);
        };
    }

    private raiseColumnPinnedEvent(changedColumns: Column[], source: ColumnEventType) {
        if (!changedColumns.length) { return; }

        const event: ColumnPinnedEvent = {
            type: Events.EVENT_COLUMN_PINNED,
            pinned: null,
            columns: changedColumns,
            column: null,
            api: this.gridApi,
            columnApi: this.columnApi,
            source: source
        };

        this.eventService.dispatchEvent(event);
    }

    private raiseColumnVisibleEvent(changedColumns: Column[], source: ColumnEventType) {
        if (!changedColumns.length) { return; }

        const event: ColumnVisibleEvent = {
            type: Events.EVENT_COLUMN_VISIBLE,
            visible: undefined,
            columns: changedColumns,
            column: null,
            api: this.gridApi,
            columnApi: this.columnApi,
            source: source
        };

        this.eventService.dispatchEvent(event);
    }

    private raiseColumnMovedEvent(colStateBefore: ColumnState[], source: ColumnEventType) {

        // we are only interested in columns that were both present and visible before and after

        const colStateAfter = this.getColumnState();

        const colStateAfterMapped: { [id: string]: ColumnState; } = {};
        colStateAfter.forEach(s => colStateAfterMapped[s.colId] = s);

        // get id's of cols in both before and after lists
        const colsIntersectIds: { [id: string]: boolean; } = {};
        colStateBefore.forEach(s => {
            if (colStateAfterMapped[s.colId]) {
                colsIntersectIds[s.colId] = true;
            }
        });

        // filter state lists, so we only have cols that were present before and after
        const beforeFiltered = filter(colStateBefore, c => colsIntersectIds[c.colId]);
        const afterFiltered = filter(colStateAfter, c => colsIntersectIds[c.colId]);

        // see if any cols are in a different location
        const movedColumns: Column[] = [];
        afterFiltered.forEach((csAfter: ColumnState, index: number) => {
            const csBefore = beforeFiltered[index];
            if (csBefore.colId !== csAfter.colId) {
                movedColumns.push(this.getGridColumn(csBefore.colId));
            }
        });

        if (!movedColumns.length) { return; }

        const event: ColumnMovedEvent = {
            type: Events.EVENT_COLUMN_MOVED,
            columns: movedColumns,
            column: null,
            toIndex: undefined,
            api: this.gridApi,
            columnApi: this.columnApi,
            source: source
        };

        this.eventService.dispatchEvent(event);
    }

    private syncColumnWithStateItem(
        column: Column | null,
        stateItem: ColumnState,
        defaultState: ColumnState,
        rowGroupIndexes: { [key: string]: number; },
        pivotIndexes: { [key: string]: number; },
        autoCol: boolean,
        source: ColumnEventType
    ): void {

        if (!column) { return; }

        const getValue = (key1: string, key2?: string): { value1: any, value2: any; } => {
            const stateAny = stateItem as any;
            const defaultAny = defaultState as any;
            if (stateAny && (stateAny[key1] !== undefined || stateAny[key2] !== undefined)) {
                return { value1: stateAny[key1], value2: stateAny[key2] };
            } else if (defaultAny && (defaultAny[key1] !== undefined || defaultAny[key2] !== undefined)) {
                return { value1: defaultAny[key1], value2: defaultAny[key2] };
            } else {
                return { value1: undefined, value2: undefined };
            }
        };

        // following ensures we are left with boolean true or false, eg converts (null, undefined, 0) all to true
        const hide = getValue('hide').value1;
        if (hide !== undefined) {
            column.setVisible(!hide, source);
        }

        // sets pinned to 'left' or 'right'
        const pinned = getValue('pinned').value1;
        if (pinned !== undefined) {
            column.setPinned(pinned);
        }

        // if width provided and valid, use it, otherwise stick with the old width
        const minColWidth = this.gridOptionsWrapper.getMinColWidth();

        // flex
        const flex = getValue('flex').value1;
        if (flex !== undefined) {
            column.setFlex(flex);
        }

        // width - we only set width if column is not flexing
        const noFlexThisCol = column.getFlex() <= 0;
        if (noFlexThisCol) {
            // both null and undefined means we skip, as it's not possible to 'clear' width (a column must have a width)
            const width = getValue('width').value1;
            if (width != null) {
                if (minColWidth &&
                    (width >= minColWidth)) {
                    column.setActualWidth(width, source);
                }
            }
        }

        const sort = getValue('sort').value1;
        if (sort !== undefined) {
            if (sort === Constants.SORT_DESC || sort === Constants.SORT_ASC) {
                column.setSort(sort);
            } else {
                column.setSort(undefined);
            }
        }

        const sortIndex = getValue('sortIndex').value1;
        if (sortIndex !== undefined) {
            column.setSortIndex(sortIndex);
        }

        // we do not do aggFunc, rowGroup or pivot for auto cols, as you can't do these with auto col
        if (autoCol) {
            return;
        }

        const aggFunc = getValue('aggFunc').value1;
        if (aggFunc !== undefined) {
            if (typeof aggFunc === 'string') {
                column.setAggFunc(aggFunc);
                if (!column.isValueActive()) {
                    column.setValueActive(true, source);
                    this.valueColumns.push(column);
                }
            } else {
                if (exists(aggFunc)) {
                    console.warn('ag-Grid: stateItem.aggFunc must be a string. if using your own aggregation ' +
                        'functions, register the functions first before using them in get/set state. This is because it is ' +
                        'intended for the column state to be stored and retrieved as simple JSON.');
                }
                column.setAggFunc(null);
                if (column.isValueActive()) {
                    column.setValueActive(false, source);
                    removeFromArray(this.valueColumns, column);
                }
            }
        }

        const { value1: rowGroup, value2: rowGroupIndex } = getValue('rowGroup', 'rowGroupIndex');
        if (rowGroup !== undefined || rowGroupIndex !== undefined) {
            if (typeof rowGroupIndex === 'number' || rowGroup) {
                if (!column.isRowGroupActive()) {
                    column.setRowGroupActive(true, source);
                    this.rowGroupColumns.push(column);
                }
                if (typeof rowGroupIndex === 'number') {
                    rowGroupIndexes[column.getId()] = rowGroupIndex;
                }
            } else {
                if (column.isRowGroupActive()) {
                    column.setRowGroupActive(false, source);
                    removeFromArray(this.rowGroupColumns, column);
                }
            }
        }

        const { value1: pivot, value2: pivotIndex } = getValue('pivot', 'pivotIndex');
        if (pivot !== undefined || pivotIndex !== undefined) {
            if (typeof pivotIndex === 'number' || pivot) {
                if (!column.isPivotActive()) {
                    column.setPivotActive(true, source);
                    this.pivotColumns.push(column);
                }
                if (typeof pivotIndex === 'number') {
                    pivotIndexes[column.getId()] = pivotIndex;
                }
            } else {
                if (column.isPivotActive()) {
                    column.setPivotActive(false, source);
                    removeFromArray(this.pivotColumns, column);
                }
            }
        }
    }

    public getGridColumns(keys: (string | Column)[]): Column[] {
        return this.getColumns(keys, this.getGridColumn.bind(this));
    }

    private getColumns(keys: (string | Column)[], columnLookupCallback: (key: string | Column) => Column): Column[] {
        const foundColumns: Column[] = [];

        if (keys) {
            keys.forEach((key: (string | Column)) => {
                const column = columnLookupCallback(key);
                if (column) {
                    foundColumns.push(column);
                }
            });
        }

        return foundColumns;
    }

    // used by growGroupPanel
    public getColumnWithValidation(key: string | Column | undefined): Column | null {
        if (key == null) { return null; }

        const column = this.getGridColumn(key);

        if (!column) {
            console.warn('ag-Grid: could not find column ' + key);
        }

        return column;
    }

    public getPrimaryColumn(key: string | Column): Column | null {
        return this.getColumn(key, this.primaryColumns);
    }

    public getGridColumn(key: string | Column): Column | null {
        return this.getColumn(key, this.gridColumns);
    }

    private getColumn(key: string | Column, columnList: Column[]): Column | null {
        if (!key) { return null; }

        for (let i = 0; i < columnList.length; i++) {
            if (this.columnsMatch(columnList[i], key)) {
                return columnList[i];
            }
        }

        return this.getAutoColumn(key);
    }

    private getAutoColumn(key: string | Column): Column | null {
        if (
            !this.groupAutoColumns ||
            !exists(this.groupAutoColumns) ||
            missing(this.groupAutoColumns)
        ) { return null; }

        return find(this.groupAutoColumns, groupCol => this.columnsMatch(groupCol, key));
    }

    private columnsMatch(column: Column, key: string | Column): boolean {
        const columnMatches = column === key;
        const colDefMatches = column.getColDef() === key;
        const idMatches = column.getColId() == key;

        return columnMatches || colDefMatches || idMatches;
    }

    public getDisplayNameForColumn(column: Column | null, location: string | null, includeAggFunc = false): string | null {
        if (!column) { return null; }

        const headerName: string | null = this.getHeaderName(column.getColDef(), column, null, null, location);

        if (includeAggFunc) {
            return this.wrapHeaderNameWithAggFunc(column, headerName);
        }

        return headerName;
    }

    public getDisplayNameForOriginalColumnGroup(
        columnGroup: ColumnGroup | null,
        originalColumnGroup: OriginalColumnGroup | null,
        location: string
    ): string | null {
        const colGroupDef = originalColumnGroup ? originalColumnGroup.getColGroupDef() : null;

        if (colGroupDef) {
            return this.getHeaderName(colGroupDef, null, columnGroup, originalColumnGroup, location);
        }

        return null;
    }

    public getDisplayNameForColumnGroup(columnGroup: ColumnGroup, location: string): string | null {
        return this.getDisplayNameForOriginalColumnGroup(columnGroup, columnGroup.getOriginalColumnGroup(), location);
    }

    // location is where the column is going to appear, ie who is calling us
    private getHeaderName(
        colDef: AbstractColDef,
        column: Column | null,
        columnGroup: ColumnGroup | null,
        originalColumnGroup: OriginalColumnGroup | null,
        location: string | null
    ): string | null {
        const headerValueGetter = colDef.headerValueGetter;

        if (headerValueGetter) {
            const params = {
                colDef: colDef,
                column: column,
                columnGroup: columnGroup,
                originalColumnGroup: originalColumnGroup,
                location: location,
                api: this.gridOptionsWrapper.getApi(),
                context: this.gridOptionsWrapper.getContext()
            };

            if (typeof headerValueGetter === 'function') {
                // valueGetter is a function, so just call it
                return headerValueGetter(params);
            } else if (typeof headerValueGetter === 'string') {
                // valueGetter is an expression, so execute the expression
                return this.expressionService.evaluate(headerValueGetter, params);
            }
            console.warn('ag-grid: headerValueGetter must be a function or a string');
            return '';
        } else if (colDef.headerName != null) {
            return colDef.headerName;
        } else if ((colDef as ColDef).field) {
            return camelCaseToHumanText((colDef as ColDef).field);
        }

        return '';
    }

    /*
        private getHeaderGroupName(columnGroup: ColumnGroup): string {
            let colGroupDef = columnGroup.getOriginalColumnGroup().getColGroupDef();
            let headerValueGetter = colGroupDef.headerValueGetter;

            if (headerValueGetter) {
                let params = {
                    columnGroup: columnGroup,
                    colDef: colGroupDef,
                    api: this.gridOptionsWrapper.getApi(),
                    context: this.gridOptionsWrapper.getContext()
                };

                if (typeof headerValueGetter === 'function') {
                    // valueGetter is a function, so just call it
                    return headerValueGetter(params);
                } else if (typeof headerValueGetter === 'string') {
                    // valueGetter is an expression, so execute the expression
                    return this.expressionService.evaluate(headerValueGetter, params);
                } else {
                    console.warn('ag-grid: headerValueGetter must be a function or a string');
                    return '';
                }
            } else {
                return colGroupDef.headerName;
            }
        }
    */

    private wrapHeaderNameWithAggFunc(column: Column, headerName: string | null): string | null {
        if (this.gridOptionsWrapper.isSuppressAggFuncInHeader()) { return headerName; }

        // only columns with aggregation active can have aggregations
        const pivotValueColumn = column.getColDef().pivotValueColumn;
        const pivotActiveOnThisColumn = exists(pivotValueColumn);
        let aggFunc: string | IAggFunc | null = null;
        let aggFuncFound: boolean;

        // otherwise we have a measure that is active, and we are doing aggregation on it
        if (pivotActiveOnThisColumn) {
            aggFunc = pivotValueColumn ? pivotValueColumn.getAggFunc() : null;
            aggFuncFound = true;
        } else {
            const measureActive = column.isValueActive();
            const aggregationPresent = this.pivotMode || !this.isRowGroupEmpty();

            if (measureActive && aggregationPresent) {
                aggFunc = column.getAggFunc();
                aggFuncFound = true;
            } else {
                aggFuncFound = false;
            }
        }

        if (aggFuncFound) {
            const aggFuncString = (typeof aggFunc === 'string') ? aggFunc : 'func';
            const localeTextFunc = this.gridOptionsWrapper.getLocaleTextFunc();
            const aggFuncStringTranslated = localeTextFunc(aggFuncString, aggFuncString);
            return `${aggFuncStringTranslated}(${headerName})`;
        }

        return headerName;
    }

    // returns the group with matching colId and instanceId. If instanceId is missing,
    // matches only on the colId.
    public getColumnGroup(colId: string | ColumnGroup, instanceId?: number): ColumnGroup | null {
        if (!colId) { return null; }
        if (colId instanceof ColumnGroup) { return colId; }

        const allColumnGroups = this.getAllDisplayedColumnGroups();
        const checkInstanceId = typeof instanceId === 'number';
        let result: ColumnGroup | null = null;

        this.columnUtils.depthFirstAllColumnTreeSearch(allColumnGroups, (child: ColumnGroupChild) => {
            if (child instanceof ColumnGroup) {
                const columnGroup = child;
                let matched: boolean;

                if (checkInstanceId) {
                    matched = colId === columnGroup.getGroupId() && instanceId === columnGroup.getInstanceId();
                } else {
                    matched = colId === columnGroup.getGroupId();
                }

                if (matched) {
                    result = columnGroup;
                }
            }
        });

        return result;
    }

    public isReady(): boolean {
        return this.ready;
    }

    private extractValueColumns(source: ColumnEventType, oldPrimaryColumns: Column[]): void {
        this.valueColumns = this.extractColumns(oldPrimaryColumns, this.valueColumns,
            (col: Column, flag: boolean) => col.setValueActive(flag, source),
            // aggFunc doesn't have index variant, cos order of value cols doesn't matter, so always return null
            () => undefined,
            () => undefined,
            // aggFunc is a string, so return it's existence
            (colDef: ColDef) => {
                const aggFunc = colDef.aggFunc;
                // null or empty string means clear
                if (aggFunc === null || aggFunc === '') {
                    return null;
                } else if (aggFunc === undefined) {
                    return undefined;
                } else {
                    return aggFunc != '';
                }
            },
            (colDef: ColDef) => {
                // return false if any of the following: null, undefined, empty string
                return colDef.initialAggFunc != null && colDef.initialAggFunc != '';
            }
        );

        // all new columns added will have aggFunc missing, so set it to what is in the colDef
        this.valueColumns.forEach(col => {
            const colDef = col.getColDef();
            // if aggFunc provided, we always override, as reactive property
            if (colDef.aggFunc != null && colDef.aggFunc != '') {
                col.setAggFunc(colDef.aggFunc);
            } else {
                // otherwise we use initialAggFunc only if no agg func set - which happens when new column only
                if (!col.getAggFunc()) {
                    col.setAggFunc(colDef.initialAggFunc);
                }
            }
        });
    }

    private extractRowGroupColumns(source: ColumnEventType, oldPrimaryColumns: Column[]): void {
        this.rowGroupColumns = this.extractColumns(oldPrimaryColumns, this.rowGroupColumns,
            (col: Column, flag: boolean) => col.setRowGroupActive(flag, source),
            (colDef: ColDef) => colDef.rowGroupIndex,
            (colDef: ColDef) => colDef.initialRowGroupIndex,
            (colDef: ColDef) => colDef.rowGroup,
            (colDef: ColDef) => colDef.initialRowGroup,
        );
    }

    private extractColumns(
        oldPrimaryColumns: Column[] = [],
        previousCols: Column[] = [],
        setFlagFunc: (col: Column, flag: boolean) => void,
        getIndexFunc: (colDef: ColDef) => number | null | undefined,
        getInitialIndexFunc: (colDef: ColDef) => number | null | undefined,
        getValueFunc: (colDef: ColDef) => boolean | undefined,
        getInitialValueFunc: (colDef: ColDef) => boolean | undefined
    ): Column[] {

        const colsWithIndex: Column[] = [];
        const colsWithValue: Column[] = [];

        // go though all cols.
        // if value, change
        // if default only, change only if new
        this.primaryColumns.forEach(col => {
            const colIsNew = oldPrimaryColumns.indexOf(col) < 0;
            const colDef = col.getColDef();

            const value = attrToBoolean(getValueFunc(colDef));
            const initialValue = attrToBoolean(getInitialValueFunc(colDef));
            const index = attrToNumber(getIndexFunc(colDef));
            const initialIndex = attrToNumber(getInitialIndexFunc(colDef));

            let include: boolean;

            if (colIsNew) {
                // col is new, use values if present, otherwise use default values if present
                const valuePresent = value !== undefined || index !== undefined;
                if (valuePresent) {
                    if (value !== undefined) {
                        // if boolean value present, we take it's value, even if 'false'
                        include = value;
                    } else {
                        // otherwise we based on number value. note that 'null' resets, however 'undefined' doesn't
                        // go through this code path (undefined means 'ignore').
                        include = index >= 0;
                    }
                } else {
                    include = initialValue == true || initialIndex >= 0;
                }
            } else {
                // col is not new, we ignore the default values, just use the values if provided
                if (value !== undefined) { // value is never null, as attrToBoolean converts null to false
                    include = value;
                } else if (index !== undefined) {
                    if (index === null) {
                        include = false;
                    } else {
                        include = index >= 0;
                    }
                } else {
                    // no values provided, we include if it was included last time
                    include = previousCols.indexOf(col) >= 0;
                }
            }

            if (include) {
                const useIndex = colIsNew ? (index != null || initialIndex != null) : index != null;
                if (useIndex) {
                    colsWithIndex.push(col);
                } else {
                    colsWithValue.push(col);
                }
            }
        });

        const getIndexForCol = (col: Column): number => {
            const index = getIndexFunc(col.getColDef());
            const defaultIndex = getInitialIndexFunc(col.getColDef());
            return index != null ? index : defaultIndex;
        };

        // sort cols with index, and add these first
        colsWithIndex.sort(function(colA: Column, colB: Column): number {
            const indexA = getIndexForCol(colA);
            const indexB = getIndexForCol(colB);
            if (indexA === indexB) {
                return 0;
            } else if (indexA < indexB) {
                return -1;
            } else {
                return 1;
            }
        });

        const res: Column[] = [].concat(colsWithIndex);

        // second add columns that were there before and in the same order as they were before,
        // so we are preserving order of current grouping of columns that simply have rowGroup=true
        previousCols.forEach(col => {
            if (colsWithValue.indexOf(col) >= 0) {
                res.push(col);
            }
        });

        // lastly put in all remaining cols
        colsWithValue.forEach(col => {
            if (res.indexOf(col) < 0) {
                res.push(col);
            }
        });

        // set flag=false for removed cols
        previousCols.forEach(col => {
            if (res.indexOf(col) < 0) {
                setFlagFunc(col, false);
            }
        });
        // set flag=true for newly added cols
        res.forEach(col => {
            if (previousCols.indexOf(col) < 0) {
                setFlagFunc(col, true);
            }
        });

        return res;
    }

    private extractPivotColumns(source: ColumnEventType, oldPrimaryColumns: Column[]): void {
        this.pivotColumns = this.extractColumns(oldPrimaryColumns, this.pivotColumns,
            (col: Column, flag: boolean) => col.setPivotActive(flag, source),
            (colDef: ColDef) => colDef.pivotIndex,
            (colDef: ColDef) => colDef.initialPivotIndex,
            (colDef: ColDef) => colDef.pivot,
            (colDef: ColDef) => colDef.initialPivot,
        );
    }

    public resetColumnGroupState(source: ColumnEventType = "api"): void {
        const stateItems: { groupId: string, open: boolean | undefined; }[] = [];

        this.columnUtils.depthFirstOriginalTreeSearch(null, this.primaryColumnTree, child => {
            if (child instanceof OriginalColumnGroup) {
                const groupState = {
                    groupId: child.getGroupId(),
                    open: child.getColGroupDef().openByDefault
                };
                stateItems.push(groupState);
            }
        });

        this.setColumnGroupState(stateItems, source);
    }

    public getColumnGroupState(): { groupId: string, open: boolean; }[] {
        const columnGroupState: { groupId: string, open: boolean; }[] = [];

        this.columnUtils.depthFirstOriginalTreeSearch(null, this.gridBalancedTree, node => {
            if (node instanceof OriginalColumnGroup) {
                const originalColumnGroup = node;
                columnGroupState.push({
                    groupId: originalColumnGroup.getGroupId(),
                    open: originalColumnGroup.isExpanded()
                });
            }
        });

        return columnGroupState;
    }

    public setColumnGroupState(stateItems: { groupId: string, open: boolean | undefined; }[], source: ColumnEventType = "api"): void {
        this.columnAnimationService.start();

        const impactedGroups: OriginalColumnGroup[] = [];

        stateItems.forEach(stateItem => {
            const groupKey = stateItem.groupId;
            const newValue = stateItem.open;
            const originalColumnGroup: OriginalColumnGroup | null = this.getOriginalColumnGroup(groupKey);

            if (!originalColumnGroup) { return; }
            if (originalColumnGroup.isExpanded() === newValue) { return; }

            this.logger.log('columnGroupOpened(' + originalColumnGroup.getGroupId() + ',' + newValue + ')');
            originalColumnGroup.setExpanded(newValue);
            impactedGroups.push(originalColumnGroup);
        });

        this.updateGroupsAndDisplayedColumns(source);
        this.setFirstRightAndLastLeftPinned(source);

        impactedGroups.forEach(originalColumnGroup => {
            const event: ColumnGroupOpenedEvent = {
                type: Events.EVENT_COLUMN_GROUP_OPENED,
                columnGroup: originalColumnGroup,
                api: this.gridApi,
                columnApi: this.columnApi
            };
            this.eventService.dispatchEvent(event);
        });

        this.columnAnimationService.finish();
    }

    // called by headerRenderer - when a header is opened or closed
    public setColumnGroupOpened(key: OriginalColumnGroup | string | undefined, newValue: boolean, source: ColumnEventType = "api"): void {
        let keyAsString: string;

        if (key instanceof OriginalColumnGroup) {
            keyAsString = key.getId();
        } else {
            keyAsString = key;
        }
        this.setColumnGroupState([{ groupId: keyAsString, open: newValue }], source);
    }

    public getOriginalColumnGroup(key: OriginalColumnGroup | string): OriginalColumnGroup | null {
        if (key instanceof OriginalColumnGroup) { return key; }

        if (typeof key !== 'string') {
            console.error('ag-Grid: group key must be a string');
        }

        // otherwise, search for the column group by id
        let res: OriginalColumnGroup | null = null;

        this.columnUtils.depthFirstOriginalTreeSearch(null, this.gridBalancedTree, node => {
            if (node instanceof OriginalColumnGroup) {
                const originalColumnGroup = node;
                if (originalColumnGroup.getId() === key) {
                    res = originalColumnGroup;
                }
            }
        });

        return res;
    }

    private calculateColumnsForDisplay(): Column[] {
        let columnsForDisplay: Column[];

        if (this.pivotMode && !this.secondaryColumnsPresent) {
            // pivot mode is on, but we are not pivoting, so we only
            // show columns we are aggregating on
            columnsForDisplay = this.gridColumns.filter(column => {
                const isAutoGroupCol = this.groupAutoColumns && includes(this.groupAutoColumns, column);
                const isValueCol = this.valueColumns && includes(this.valueColumns, column);
                return isAutoGroupCol || isValueCol;
            });

        } else {
            // otherwise continue as normal. this can be working on the primary
            // or secondary columns, whatever the gridColumns are set to
            columnsForDisplay = this.gridColumns.filter(column => {
                // keep col if a) it's auto-group or b) it's visible
                const isAutoGroupCol = this.groupAutoColumns && includes(this.groupAutoColumns, column);
                return isAutoGroupCol || column.isVisible();
            });
        }

        return columnsForDisplay;
    }

    private checkColSpanActiveInCols(columns: Column[]): boolean {
        let result = false;

        columns.forEach(col => {
            if (exists(col.getColDef().colSpan)) {
                result = true;
            }
        });

        return result;
    }

    private calculateColumnsForGroupDisplay(): void {
        this.groupDisplayColumns = [];

        const checkFunc = (col: Column) => {
            const colDef = col.getColDef();
            if (colDef && exists(colDef.showRowGroup)) {
                this.groupDisplayColumns.push(col);
            }
        };

        this.gridColumns.forEach(checkFunc);

        if (this.groupAutoColumns) {
            this.groupAutoColumns.forEach(checkFunc);
        }
    }

    public getGroupDisplayColumns(): Column[] {
        return this.groupDisplayColumns;
    }

    private updateDisplayedColumns(source: ColumnEventType): void {
        const columnsForDisplay = this.calculateColumnsForDisplay();

        this.buildDisplayedTrees(columnsForDisplay);
        this.calculateColumnsForGroupDisplay();

        // also called when group opened/closed
        this.updateGroupsAndDisplayedColumns(source);

        // also called when group opened/closed
        this.setFirstRightAndLastLeftPinned(source);
    }

    public isSecondaryColumnsPresent(): boolean {
        return this.secondaryColumnsPresent;
    }

    public setSecondaryColumns(colDefs: (ColDef | ColGroupDef)[] | null, source: ColumnEventType = "api"): void {
        const newColsPresent = colDefs && colDefs.length > 0;

        // if not cols passed, and we had to cols anyway, then do nothing
        if (!newColsPresent && !this.secondaryColumnsPresent) { return; }

        if (newColsPresent) {
            this.processSecondaryColumnDefinitions(colDefs);
            const balancedTreeResult = this.columnFactory.createColumnTree(colDefs, false);
            this.secondaryBalancedTree = balancedTreeResult.columnTree;
            this.secondaryHeaderRowCount = balancedTreeResult.treeDept + 1;
            this.secondaryColumns = this.getColumnsFromTree(this.secondaryBalancedTree);
            this.secondaryColumnsPresent = true;
        } else {
            this.secondaryBalancedTree = null;
            this.secondaryHeaderRowCount = -1;
            this.secondaryColumns = null;
            this.secondaryColumnsPresent = false;
        }

        this.updateGridColumns();
        this.updateDisplayedColumns(source);
    }

    private processSecondaryColumnDefinitions(colDefs: (ColDef | ColGroupDef)[] | null): (ColDef | ColGroupDef)[] | undefined {

        const columnCallback = this.gridOptionsWrapper.getProcessSecondaryColDefFunc();
        const groupCallback = this.gridOptionsWrapper.getProcessSecondaryColGroupDefFunc();

        if (!columnCallback && !groupCallback) { return undefined; }

        const searchForColDefs = (colDefs2: (ColDef | ColGroupDef)[]): void => {
            colDefs2.forEach(function(abstractColDef: AbstractColDef) {
                const isGroup = exists((abstractColDef as any).children);
                if (isGroup) {
                    const colGroupDef = abstractColDef as ColGroupDef;
                    if (groupCallback) {
                        groupCallback(colGroupDef);
                    }
                    searchForColDefs(colGroupDef.children);
                } else {
                    const colDef = abstractColDef as ColGroupDef;
                    if (columnCallback) {
                        columnCallback(colDef);
                    }
                }
            });
        };

        if (colDefs) {
            searchForColDefs(colDefs);
        }
    }

    // called from: setColumnState, setColumnDefs, setSecondaryColumns
    private updateGridColumns(): void {
        if (this.gridColsArePrimary) {
            this.lastPrimaryOrder = this.gridColumns;
        }

        if (this.secondaryColumns && this.secondaryBalancedTree) {
            this.gridBalancedTree = this.secondaryBalancedTree.slice();
            this.gridHeaderRowCount = this.secondaryHeaderRowCount;
            this.gridColumns = this.secondaryColumns.slice();
            this.gridColsArePrimary = false;
        } else {
            this.gridBalancedTree = this.primaryColumnTree.slice();
            this.gridHeaderRowCount = this.primaryHeaderRowCount;
            this.gridColumns = this.primaryColumns.slice();
            this.gridColsArePrimary = true;

            // updateGridColumns gets called after user adds a row group. we want to maintain the order of the columns
            // when this happens (eg if user moved a column) rather than revert back to the original column order.
            // likewise if changing in/out of pivot mode, we want to maintain the order of the primary cols
            this.orderGridColsLikeLastPrimary();
        }

        this.addAutoGroupToGridColumns();

        this.autoRowHeightColumns = this.gridColumns.filter(col => col.getColDef().autoHeight);

        this.putFixedColumnsFirst();
        this.setupQuickFilterColumns();
        this.clearDisplayedColumns();

        this.colSpanActive = this.checkColSpanActiveInCols(this.gridColumns);

        const event: GridColumnsChangedEvent = {
            type: Events.EVENT_GRID_COLUMNS_CHANGED,
            api: this.gridApi,
            columnApi: this.columnApi
        };

        this.eventService.dispatchEvent(event);
    }

    private orderGridColsLikeLastPrimary(): void {
        if (missing(this.lastPrimaryOrder)) { return; }

        // only do the sort if at least one column is accounted for. columns will be not accounted for
        // if changing from secondary to primary columns
        let noColsFound = true;
        this.gridColumns.forEach(col => {
            if (this.lastPrimaryOrder.indexOf(col) >= 0) {
                noColsFound = false;
            }
        });

        if (noColsFound) { return; }

        // order cols in the same order as before. we need to make sure that all
        // cols still exists, so filter out any that no longer exist.
        const oldColsOrdered = this.lastPrimaryOrder.filter(col => this.gridColumns.indexOf(col) >= 0);
        const newColsOrdered = this.gridColumns.filter(col => oldColsOrdered.indexOf(col) < 0);

        // add in the new columns, at the end (if no group), or at the end of the group (if a group)
        const newGridColumns = oldColsOrdered.slice();

        newColsOrdered.forEach(newCol => {
            let parent = newCol.getOriginalParent();

            // if no parent, means we are not grouping, so just add the column to the end
            if (!parent) {
                newGridColumns.push(newCol);
                return;
            }

            // find the group the column belongs to. if no siblings at the current level (eg col in group on it's
            // own) then go up one level and look for siblings there.
            const siblings: Column[] = [];
            while (!siblings.length && parent) {
                const leafCols = parent.getLeafColumns();
                leafCols.forEach(leafCol => {
                    const presentInNewGriColumns = newGridColumns.indexOf(leafCol) >= 0;
                    const noYetInSiblings = siblings.indexOf(leafCol) < 0;
                    if (presentInNewGriColumns && noYetInSiblings) {
                        siblings.push(leafCol);
                    }
                });
                parent = parent.getOriginalParent();
            }

            // if no siblings exist at any level, this means the col is in a group (or parent groups) on it's own
            if (!siblings.length) {
                newGridColumns.push(newCol);
                return;
            }

            // find index of last column in the group
            const indexes = siblings.map(col => newGridColumns.indexOf(col));
            const lastIndex = Math.max(...indexes);

            insertIntoArray(newGridColumns, newCol, lastIndex + 1);
        });

        this.gridColumns = newGridColumns;
    }

    public isPrimaryColumnGroupsPresent(): boolean {
        return this.primaryHeaderRowCount > 1;
    }

    // if we are using autoGroupCols, then they should be included for quick filter. this covers the
    // following scenarios:
    // a) user provides 'field' into autoGroupCol of normal grid, so now because a valid col to filter leafs on
    // b) using tree data and user depends on autoGroupCol for first col, and we also want to filter on this
    //    (tree data is a bit different, as parent rows can be filtered on, unlike row grouping)
    private setupQuickFilterColumns(): void {
        if (this.groupAutoColumns) {
            this.columnsForQuickFilter = this.primaryColumns.concat(this.groupAutoColumns);
        } else {
            this.columnsForQuickFilter = this.primaryColumns;
        }
    }

    private putFixedColumnsFirst(): void {
        const locked = this.gridColumns.filter(c => c.getColDef().lockPosition);
        const unlocked = this.gridColumns.filter(c => !c.getColDef().lockPosition);
        this.gridColumns = locked.concat(unlocked);
    }

    private addAutoGroupToGridColumns(): void {
        // add in auto-group here
        this.createGroupAutoColumnsIfNeeded();

        if (missing(this.groupAutoColumns)) { return; }

        this.gridColumns = this.groupAutoColumns ? this.groupAutoColumns.concat(this.gridColumns) : this.gridColumns;

        const autoColBalancedTree = this.columnFactory.createForAutoGroups(this.groupAutoColumns, this.gridBalancedTree);

        this.gridBalancedTree = autoColBalancedTree.concat(this.gridBalancedTree);
    }

    // gets called after we copy down grid columns, to make sure any part of the gui
    // that tries to draw, eg the header, it will get empty lists of columns rather
    // than stale columns. for example, the header will received gridColumnsChanged
    // event, so will try and draw, but it will draw successfully when it acts on the
    // virtualColumnsChanged event
    private clearDisplayedColumns(): void {
        this.displayedLeftColumnTree = [];
        this.displayedRightColumnTree = [];
        this.displayedCentreColumnTree = [];

        this.displayedLeftHeaderRows = {};
        this.displayedRightHeaderRows = {};
        this.displayedCentreHeaderRows = {};

        this.displayedLeftColumns = [];
        this.displayedRightColumns = [];
        this.displayedCenterColumns = [];
        this.allDisplayedColumns = [];
        this.allDisplayedVirtualColumns = [];
    }

    private updateGroupsAndDisplayedColumns(source: ColumnEventType) {
        this.updateOpenClosedVisibilityInColumnGroups();
        this.updateDisplayedColumnsFromTrees(source);
        this.refreshFlexedColumns();
        this.updateVirtualSets();
        this.updateBodyWidths();
        // this event is picked up by the gui, headerRenderer and rowRenderer, to recalculate what columns to display

        const event: DisplayedColumnsChangedEvent = {
            type: Events.EVENT_DISPLAYED_COLUMNS_CHANGED,
            api: this.gridApi,
            columnApi: this.columnApi
        };
        this.eventService.dispatchEvent(event);
    }

    private updateDisplayedColumnsFromTrees(source: ColumnEventType): void {
        this.addToDisplayedColumns(this.displayedLeftColumnTree, this.displayedLeftColumns);
        this.addToDisplayedColumns(this.displayedCentreColumnTree, this.displayedCenterColumns);
        this.addToDisplayedColumns(this.displayedRightColumnTree, this.displayedRightColumns);
        this.setupAllDisplayedColumns();
        this.setLeftValues(source);
    }

    private setupAllDisplayedColumns(): void {
        if (this.gridOptionsWrapper.isEnableRtl()) {
            this.allDisplayedColumns = this.displayedRightColumns
                .concat(this.displayedCenterColumns)
                .concat(this.displayedLeftColumns);
        } else {
            this.allDisplayedColumns = this.displayedLeftColumns
                .concat(this.displayedCenterColumns)
                .concat(this.displayedRightColumns);
        }
    }

    // sets the left pixel position of each column
    private setLeftValues(source: ColumnEventType): void {
        this.setLeftValuesOfColumns(source);
        this.setLeftValuesOfGroups();
    }

    private setLeftValuesOfColumns(source: ColumnEventType): void {
        // go through each list of displayed columns
        const allColumns = this.primaryColumns.slice(0);

        // let totalColumnWidth = this.getWidthOfColsInList()
        const doingRtl = this.gridOptionsWrapper.isEnableRtl();

        [
            this.displayedLeftColumns,
            this.displayedRightColumns,
            this.displayedCenterColumns
        ].forEach(columns => {
            if (doingRtl) {
                // when doing RTL, we start at the top most pixel (ie RHS) and work backwards
                let left = this.getWidthOfColsInList(columns);
                columns.forEach(column => {
                    left -= column.getActualWidth();
                    column.setLeft(left, source);
                });
            } else {
                // otherwise normal LTR, we start at zero
                let left = 0;
                columns.forEach(column => {
                    column.setLeft(left, source);
                    left += column.getActualWidth();
                });
            }
            removeAllFromArray(allColumns, columns);
        });

        // items left in allColumns are columns not displayed, so remove the left position. this is
        // important for the rows, as if a col is made visible, then taken out, then made visible again,
        // we don't want the animation of the cell floating in from the old position, whatever that was.
        allColumns.forEach((column: Column) => {
            column.setLeft(null, source);
        });
    }

    private setLeftValuesOfGroups(): void {
        // a groups left value is the lest left value of it's children
        [
            this.displayedLeftColumnTree,
            this.displayedRightColumnTree,
            this.displayedCentreColumnTree
        ].forEach(columns => {
            columns.forEach(column => {
                if (column instanceof ColumnGroup) {
                    const columnGroup = column;
                    columnGroup.checkLeft();
                }
            });
        });
    }

    private addToDisplayedColumns(displayedColumnTree: ColumnGroupChild[], displayedColumns: Column[]): void {
        displayedColumns.length = 0;
        this.columnUtils.depthFirstDisplayedColumnTreeSearch(displayedColumnTree, (child: ColumnGroupChild) => {
            if (child instanceof Column) {
                displayedColumns.push(child);
            }
        });
    }

    private updateDisplayedCenterVirtualColumns(): { [key: string]: boolean; } {
        if (this.suppressColumnVirtualisation) {
            // no virtualisation, so don't filter
            this.allDisplayedCenterVirtualColumns = this.displayedCenterColumns;
        } else {
            // filter out what should be visible
            this.allDisplayedCenterVirtualColumns = this.filterOutColumnsWithinViewport();
        }

        this.allDisplayedVirtualColumns = this.allDisplayedCenterVirtualColumns
            .concat(this.displayedLeftColumns)
            .concat(this.displayedRightColumns);

        // return map of virtual col id's, for easy lookup when building the groups.
        // the map will be colId=>true, ie col id's mapping to 'true'.
        const result: any = {};

        this.allDisplayedVirtualColumns.forEach((col: Column) => {
            result[col.getId()] = true;
        });

        return result;
    }

    public getVirtualHeaderGroupRow(type: string, dept: number): ColumnGroupChild[] {
        let result: ColumnGroupChild[];

        switch (type) {
            case Constants.PINNED_LEFT:
                result = this.displayedLeftHeaderRows[dept];
                break;
            case Constants.PINNED_RIGHT:
                result = this.displayedRightHeaderRows[dept];
                break;
            default:
                result = this.displayedCentreHeaderRows[dept];
                break;
        }

        if (missing(result)) {
            result = [];
        }

        return result;
    }

    private updateDisplayedVirtualGroups(virtualColIds: any): void {
        // go through each group, see if any of it's cols are displayed, and if yes,
        // then this group is included
        this.displayedLeftHeaderRows = {};
        this.displayedRightHeaderRows = {};
        this.displayedCentreHeaderRows = {};

        const testGroup = (children: ColumnGroupChild[], result: { [row: number]: ColumnGroupChild[]; }, dept: number): boolean => {
            let returnValue = false;

            for (let i = 0; i < children.length; i++) {
                // see if this item is within viewport
                const child = children[i];
                let addThisItem: boolean;
                if (child instanceof Column) {
                    // for column, test if column is included
                    addThisItem = virtualColIds[child.getId()] === true;
                } else {
                    // if group, base decision on children
                    const columnGroup = child as ColumnGroup;
                    addThisItem = testGroup(columnGroup.getDisplayedChildren(), result, dept + 1);
                }

                if (addThisItem) {
                    returnValue = true;
                    if (!result[dept]) {
                        result[dept] = [];
                    }
                    result[dept].push(child);
                }
            }
            return returnValue;
        };

        testGroup(this.displayedLeftColumnTree, this.displayedLeftHeaderRows, 0);
        testGroup(this.displayedRightColumnTree, this.displayedRightHeaderRows, 0);
        testGroup(this.displayedCentreColumnTree, this.displayedCentreHeaderRows, 0);
    }

    private updateVirtualSets(): void {
        const virtualColIds = this.updateDisplayedCenterVirtualColumns();
        this.updateDisplayedVirtualGroups(virtualColIds);
    }

    private filterOutColumnsWithinViewport(): Column[] {
        return this.displayedCenterColumns.filter(this.isColumnInViewport.bind(this));
    }

    public refreshFlexedColumns(params: { resizingCols?: Column[], skipSetLeft?: boolean, viewportWidth?: number, source?: ColumnEventType, fireResizedEvent?: boolean, updateBodyWidths?: boolean; } = {}): Column[] {
        const source = params.source ? params.source : 'flex';

        if (params.viewportWidth != null) {
            this.flexViewportWidth = params.viewportWidth;
        }

        if (!this.flexViewportWidth) { return; }

        // If the grid has left-over space, divide it between flexing columns in proportion to their flex value.
        // A "flexing column" is one that has a 'flex' value set and is not currently being constrained by its
        // minWidth or maxWidth rules.

        let flexAfterDisplayIndex = -1;
        if (params.resizingCols) {
            params.resizingCols.forEach(col => {
                const indexOfCol = this.displayedCenterColumns.indexOf(col);
                if (flexAfterDisplayIndex < indexOfCol) {
                    flexAfterDisplayIndex = indexOfCol;
                }
            });
        }

        const isColFlex = (col: Column) => {
            const afterResizingCols = this.displayedCenterColumns.indexOf(col) > flexAfterDisplayIndex;
            return col.getFlex() && afterResizingCols;
        };
        const knownWidthColumns = this.displayedCenterColumns.filter(col => !isColFlex(col));
        const flexingColumns = this.displayedCenterColumns.filter(col => isColFlex(col));
        const changedColumns: Column[] = [];

        if (!flexingColumns.length) {
            return [];
        }

        const flexingColumnSizes: number[] = [];
        let spaceForFlexingColumns: number;

        outer: while (true) {
            const totalFlex = flexingColumns.reduce((count, col) => count + col.getFlex(), 0);
            spaceForFlexingColumns = this.flexViewportWidth - this.getWidthOfColsInList(knownWidthColumns);
            for (let i = 0; i < flexingColumns.length; i++) {
                const col = flexingColumns[i];
                const widthByFlexRule = spaceForFlexingColumns * col.getFlex() / totalFlex;
                let constrainedWidth: number;
                if (widthByFlexRule < col.getMinWidth()) {
                    constrainedWidth = col.getMinWidth();
                } else if (col.getMaxWidth() != null && widthByFlexRule > col.getMaxWidth()) {
                    constrainedWidth = col.getMaxWidth();
                }
                if (constrainedWidth) {
                    // This column is not in fact flexing as it is being constrained to a specific size
                    // so remove it from the list of flexing columns and start again
                    col.setActualWidth(constrainedWidth, source);
                    removeFromArray(flexingColumns, col);
                    changedColumns.push(col);
                    knownWidthColumns.push(col);
                    continue outer;
                }
                flexingColumnSizes[i] = Math.round(widthByFlexRule);
            }
            break;
        }

        let remainingSpace = spaceForFlexingColumns;
        flexingColumns.forEach((col, i) => {
            col.setActualWidth(Math.min(flexingColumnSizes[i], remainingSpace), source);
            changedColumns.push(col);
            remainingSpace -= flexingColumnSizes[i];
        });

        if (!params.skipSetLeft) {
            this.setLeftValues(source);
        }

        if (params.updateBodyWidths) {
            this.updateBodyWidths();
        }

        if (params.fireResizedEvent) {
            this.fireColumnResizedEvent(changedColumns, true, source, flexingColumns);
        }

        // if the user sets rowData directly into GridOptions, then the row data is set before
        // grid is attached to the DOM. this means the columns are not flexed, and then the rows
        // have the wrong height (as they depend on column widths). so once the columns have
        // been flexed for the first time (only happens once grid is attached to DOM, as dependency
        // on getting the grid width, which only happens after attached after ResizeObserver fires)
        // we get get rows to re-calc their heights.
        if (!this.flexColsCalculatedAtLestOnce) {
            if (this.gridOptionsWrapper.isRowModelDefault()) {
                (this.rowModel as IClientSideRowModel).resetRowHeights();
            }
            this.flexColsCalculatedAtLestOnce = true;
        }

        return flexingColumns;
    }

    private flexColsCalculatedAtLestOnce = false;

    // called from api
    public sizeColumnsToFit(gridWidth: any, source: ColumnEventType = "sizeColumnsToFit", silent?: boolean): void {
        // avoid divide by zero
        const allDisplayedColumns = this.getAllDisplayedColumns();

        if (gridWidth <= 0 || !allDisplayedColumns.length) { return; }

        const colsToSpread: Column[] = [];
        const colsToNotSpread: Column[] = [];

        allDisplayedColumns.forEach(column => {
            if (column.getColDef().suppressSizeToFit === true) {
                colsToNotSpread.push(column);
            } else {
                colsToSpread.push(column);
            }
        });

        // make a copy of the cols that are going to be resized
        const colsToFireEventFor = colsToSpread.slice(0);
        let finishedResizing = false;

        const moveToNotSpread = (column: Column) => {
            removeFromArray(colsToSpread, column);
            colsToNotSpread.push(column);
        };

        // resetting cols to their original width makes the sizeColumnsToFit more deterministic,
        // rather than depending on the current size of the columns. most users call sizeColumnsToFit
        // immediately after grid is created, so will make no difference. however if application is calling
        // sizeColumnsToFit repeatedly (eg after column group is opened / closed repeatedly) we don't want
        // the columns to start shrinking / growing over time.
        colsToSpread.forEach(column => column.resetActualWidth());

        while (!finishedResizing) {
            finishedResizing = true;
            const availablePixels = gridWidth - this.getWidthOfColsInList(colsToNotSpread);
            if (availablePixels <= 0) {
                // no width, set everything to minimum
                colsToSpread.forEach((column: Column) => {
                    column.setMinimum(source);
                });
            } else {
                const scale = availablePixels / this.getWidthOfColsInList(colsToSpread);
                // we set the pixels for the last col based on what's left, as otherwise
                // we could be a pixel or two short or extra because of rounding errors.
                let pixelsForLastCol = availablePixels;
                // backwards through loop, as we are removing items as we go
                for (let i = colsToSpread.length - 1; i >= 0; i--) {
                    const column = colsToSpread[i];
                    const newWidth = Math.round(column.getActualWidth() * scale);
                    if (newWidth < column.getMinWidth()) {
                        column.setMinimum(source);
                        moveToNotSpread(column);
                        finishedResizing = false;
                    } else if (column.isGreaterThanMax(newWidth)) {
                        column.setActualWidth(column.getMaxWidth(), source);
                        moveToNotSpread(column);
                        finishedResizing = false;
                    } else {
                        const onLastCol = i === 0;
                        if (onLastCol) {
                            column.setActualWidth(pixelsForLastCol, source);
                        } else {
                            column.setActualWidth(newWidth, source);
                        }
                    }
                    pixelsForLastCol -= newWidth;
                }
            }
        }

        this.setLeftValues(source);
        this.updateBodyWidths();

        if (silent) { return; }

        this.fireColumnResizedEvent(colsToFireEventFor, true, source);
    }

    private buildDisplayedTrees(visibleColumns: Column[]) {
        const leftVisibleColumns: Column[] = [];
        const rightVisibleColumns: Column[] = [];
        const centerVisibleColumns: Column[] = [];

        visibleColumns.forEach(column => {
            switch (column.getPinned()) {
                case "left":
                    leftVisibleColumns.push(column);
                    break;
                case "right":
                    rightVisibleColumns.push(column);
                    break;
                default:
                    centerVisibleColumns.push(column);
                    break;
            }
        });

        const groupInstanceIdCreator = new GroupInstanceIdCreator();

        this.displayedLeftColumnTree = this.displayedGroupCreator.createDisplayedGroups(
            leftVisibleColumns, this.gridBalancedTree, groupInstanceIdCreator, Constants.PINNED_LEFT, this.displayedLeftColumnTree);
        this.displayedRightColumnTree = this.displayedGroupCreator.createDisplayedGroups(
            rightVisibleColumns, this.gridBalancedTree, groupInstanceIdCreator, Constants.PINNED_RIGHT, this.displayedRightColumnTree);
        this.displayedCentreColumnTree = this.displayedGroupCreator.createDisplayedGroups(
            centerVisibleColumns, this.gridBalancedTree, groupInstanceIdCreator, null, this.displayedCentreColumnTree);
    }

    private updateOpenClosedVisibilityInColumnGroups(): void {
        const allColumnGroups = this.getAllDisplayedColumnGroups();

        this.columnUtils.depthFirstAllColumnTreeSearch(allColumnGroups, child => {
            if (child instanceof ColumnGroup) {
                const columnGroup = child;
                columnGroup.calculateDisplayedColumns();
            }
        });
    }

    public getGroupAutoColumns(): Column[] | null {
        return this.groupAutoColumns;
    }

    private createGroupAutoColumnsIfNeeded(): void {
        if (!this.autoGroupsNeedBuilding) { return; }

        this.autoGroupsNeedBuilding = false;

        const groupFullWidthRow = this.gridOptionsWrapper.isGroupUseEntireRow(this.pivotMode);
        // we need to allow suppressing auto-column separately for group and pivot as the normal situation
        // is CSRM and user provides group column themselves for normal view, but when they go into pivot the
        // columns are generated by the grid so no opportunity for user to provide group column. so need a way
        // to suppress auto-col for grouping only, and not pivot.
        // however if using Viewport RM or SSRM and user is providing the columns, the user may wish full control
        // of the group column in this instance.
        const suppressAutoColumn = this.pivotMode ?
            this.gridOptionsWrapper.isPivotSuppressAutoColumn() : this.gridOptionsWrapper.isGroupSuppressAutoColumn();

        const groupingActive = this.rowGroupColumns.length > 0 || this.usingTreeData;
        const needAutoColumns = groupingActive && !suppressAutoColumn && !groupFullWidthRow;

        if (needAutoColumns) {
            const newAutoGroupCols = this.autoGroupColService.createAutoGroupColumns(this.rowGroupColumns);
            const autoColsDifferent = !this.autoColsEqual(newAutoGroupCols, this.groupAutoColumns);
            // we force recreate when suppressColumnStateEvents changes, so new group cols pick up the new
            // definitions. otherwise we could ignore the new cols because they appear to be the same.
            if (autoColsDifferent || this.forceRecreateAutoGroups) {
                this.groupAutoColumns = newAutoGroupCols;
            }
        } else {
            this.groupAutoColumns = null;
        }
    }

    private autoColsEqual(colsA: Column[], colsB: Column[]): boolean {
        return areEqual(colsA, colsB, (a, b) => a.getColId() === b.getColId());
    }

    private getWidthOfColsInList(columnList: Column[]) {
        return columnList.reduce((width, col) => width + col.getActualWidth(), 0);
    }

    public getGridBalancedTree(): OriginalColumnGroupChild[] {
        return this.gridBalancedTree;
    }

    public hasFloatingFilters(): boolean {
        const defaultColDef = this.gridOptionsWrapper.getDefaultColDef();

        return (defaultColDef != null && defaultColDef.floatingFilter === true) ||
            (this.columnDefs != null && this.columnDefs.some((c: ColDef) => c.floatingFilter === true));
    }

    public getFirstDisplayedColumn(): Column {
        const isRtl = this.gridOptionsWrapper.isEnableRtl();
        const queryOrder: ('getDisplayedLeftColumns' | 'getDisplayedCenterColumns' | 'getDisplayedRightColumns')[] = [
            'getDisplayedLeftColumns',
            'getDisplayedCenterColumns',
            'getDisplayedRightColumns'
        ];

        if (isRtl) {
            queryOrder.reverse();
        }

        for (let i = 0; i < queryOrder.length; i++) {
            const container = this[queryOrder[i]]();
            if (container.length) {
                return isRtl ? last(container) : container[0];
            }
        }

        return null;
    }
}
